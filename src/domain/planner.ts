import { allocateStable } from "./allocation.js";
import { curveKwAt, dependencyOrder, isCurtailable, isProtected, isSchedulable } from "./devices.js";
import { ceilTo, HOUR_MS, MINUTE_MS } from "./time.js";
import type {
  CommandAction,
  DeviceConfig,
  ForecastPoint,
  HallAllocation,
  HallConfig,
  LimitWindow,
  ManualOverride,
  PlannedAction,
  Settings,
  TariffWindow,
} from "./types.js";

/** 编排器提供的设备当前假定状态（来自已下发命令与遥测）。 */
export interface AssumedState {
  running: boolean;
  runningSince: number | null;
  cappedKw: number | null;
  /** 最近一次停机的计划时刻：下一会话需留出关机间隔后再启动。 */
  lastStopAt: number | null;
}

export interface PlanInput {
  now: number;
  settings: Settings;
  halls: HallConfig[];
  devices: DeviceConfig[];
  tariff: TariffWindow[];
  limits: LimitWindow[];
  /** 当前生效的手动接管。 */
  overrides: ManualOverride[];
  assumed: Map<string, AssumedState>;
}

export interface PlanOutput {
  horizonStart: number;
  horizonEnd: number;
  entries: PlannedAction[];
  allocations: HallAllocation[];
  forecast: ForecastPoint[];
  warnings: string[];
}

interface Run {
  device: DeviceConfig;
  start: number;
  end: number;
  /** 所属开放窗口结束时刻：顺延不得越过闭馆时间。 */
  windowEnd: number;
  caps: { at: number; kw: number | null }[];
  startReason: string;
  stopReason: string;
  continued: boolean;
}

interface LimitInfo {
  id: string;
  maxKw: number;
}

export function plan(input: PlanInput): PlanOutput {
  const { settings } = input;
  const slotMs = settings.slotMinutes * MINUTE_MS;
  const horizonStart = ceilTo(input.now, slotMs);
  const windowEnds = input.halls.flatMap((hall) => hall.openWindows.map((window) => window.end));
  const naturalEnd = input.now + settings.horizonHours * HOUR_MS;
  const horizonEnd = windowEnds.length > 0 ? Math.min(naturalEnd, Math.max(...windowEnds)) : naturalEnd;

  const warnings: string[] = [];
  const hallsById = new Map(input.halls.map((hall) => [hall.id, hall]));
  const devicesById = new Map(input.devices.map((device) => [device.id, device]));
  const overridesByDevice = new Map(input.overrides.map((override) => [override.deviceId, override]));
  const assumedOf = (deviceId: string): AssumedState =>
    input.assumed.get(deviceId) ?? { running: false, runningSince: null, cappedKw: null, lastStopAt: null };

  const limitAt = (at: number): LimitInfo => {
    let best: LimitInfo = { id: "default", maxKw: settings.defaultLimitKw };
    for (const limit of input.limits) {
      if (limit.start <= at && at < limit.end && limit.maxKw <= best.maxKw) {
        best = { id: limit.id, maxKw: limit.maxKw };
      }
    }
    return best;
  };
  const priceAt = (at: number): number => {
    for (const window of input.tariff) {
      if (window.start <= at && at < window.end) {
        return window.pricePerKwh;
      }
    }
    return settings.defaultPricePerKwh;
  };

  const slotCount = Math.max(0, Math.ceil((horizonEnd - horizonStart) / slotMs));
  const slotAt = (index: number): number => horizonStart + index * slotMs;

  // 基线：连续运行设备与手动接管固定的设备，不参与排程也不得削减。
  const baseline = new Array<number>(slotCount).fill(0);
  const protectedLoad = new Array<number>(slotCount).fill(0);
  const baselineByHall = new Map<string, number[]>();
  const protectedByHall = new Map<string, number[]>();
  const hallArray = (map: Map<string, number[]>, hallId: string): number[] => {
    let arr = map.get(hallId);
    if (!arr) {
      arr = new Array<number>(slotCount).fill(0);
      map.set(hallId, arr);
    }
    return arr;
  };
  const addBaseline = (device: DeviceConfig, kw: number): void => {
    const hallBaseline = hallArray(baselineByHall, device.hallId);
    const hallProtected = isProtected(device.loadClass) ? hallArray(protectedByHall, device.hallId) : null;
    for (let index = 0; index < slotCount; index += 1) {
      baseline[index] = baseline[index]! + kw;
      hallBaseline[index] = hallBaseline[index]! + kw;
      if (hallProtected) {
        protectedLoad[index] = protectedLoad[index]! + kw;
        hallProtected[index] = hallProtected[index]! + kw;
      }
    }
  };

  for (const device of input.devices) {
    const override = overridesByDevice.get(device.id);
    const assumed = assumedOf(device.id);
    if (device.continuous || override?.mode === "force_on") {
      addBaseline(device, curveKwAt(device, 0));
      continue;
    }
    if (override?.mode === "force_off") {
      continue;
    }
    if (override?.mode === "hold") {
      if (assumed.running) {
        addBaseline(device, assumed.cappedKw ?? curveKwAt(device, 0));
      }
      continue;
    }
    if (!isSchedulable(device)) {
      // 非连续的保护类设备（罕见配置）：按基线常开处理，绝不排程削减。
      addBaseline(device, curveKwAt(device, 0));
      continue;
    }
  }

  // 可排程设备的允许窗口：展厅开放时段与时域的交集。
  const allowedWindows = (device: DeviceConfig): { start: number; end: number }[] => {
    const hall = hallsById.get(device.hallId);
    if (!hall) {
      warnings.push(`设备 ${device.id} 属于未知展厅 ${device.hallId}，未纳入计划`);
      return [];
    }
    return hall.openWindows
      .map((window) => ({ start: Math.max(window.start, horizonStart), end: Math.min(window.end, horizonEnd) }))
      .filter((window) => window.end > window.start)
      .sort((a, b) => a.start - b.start);
  };

  // 首选运行区间：访客关键负荷取最早可行时段；可延迟负荷取电价最低时段。
  const preferredRuns = new Map<string, Run>();
  for (const device of input.devices) {
    if (!isSchedulable(device) || overridesByDevice.has(device.id)) {
      continue;
    }
    const windows = allowedWindows(device);
    if (windows.length === 0) {
      continue;
    }
    const assumed = assumedOf(device.id);
    const runMs = device.runMinutes * MINUTE_MS;
    if (assumed.running && assumed.runningSince !== null) {
      // 已在运行：延续原会话到自然结束或开放时段结束，至少运行到当前时域起点。
      // 注意用未裁剪的原始开放窗口判断当前所处窗口。
      const hall = hallsById.get(device.hallId);
      const rawWindow = hall?.openWindows.find((candidate) => candidate.start <= input.now && input.now < candidate.end);
      const sessionEnd = assumed.runningSince + runMs;
      const windowEnd = Math.min(rawWindow ? rawWindow.end : horizonStart, horizonEnd);
      const end = Math.max(Math.min(sessionEnd, windowEnd), horizonStart);
      preferredRuns.set(device.id, {
        device,
        start: assumed.runningSince,
        end,
        windowEnd,
        caps: [],
        startReason: "会话进行中",
        stopReason: sessionEnd <= windowEnd ? "会话结束，按计划停机" : "开放时段结束，顺序关机",
        continued: true,
      });
      continue;
    }
    let best: { start: number; end: number; cost: number } | null = null;
    let earliest: { start: number; end: number; cost: number } | null = null;
    // 上一会话停机后留出关机间隔（不小于一个时槽），避免关停与重启落在同一时刻。
    const restGapMs = Math.max(slotMs, device.shutdownMinutes * MINUTE_MS);
    const earliestStart = Math.max(horizonStart, (assumed.lastStopAt ?? Number.NEGATIVE_INFINITY) + restGapMs);
    for (const window of windows) {
      for (let start = Math.max(window.start, earliestStart); start + runMs <= window.end; start += slotMs) {
        let cost = 0;
        for (let at = start; at < start + runMs; at += slotMs) {
          cost += priceAt(at);
        }
        const candidate = { start, end: start + runMs, cost };
        if (!earliest || candidate.start < earliest.start) {
          earliest = candidate;
        }
        if (
          !best ||
          candidate.cost < best.cost - 1e-9 ||
          (Math.abs(candidate.cost - best.cost) <= 1e-9 && candidate.start < best.start)
        ) {
          best = candidate;
        }
      }
    }
    const chosen = device.loadClass === "deferrable" ? best : earliest;
    if (!chosen) {
      warnings.push(`设备 ${device.id} 在开放时段内没有足够窗口安排 ${device.runMinutes} 分钟会话`);
      continue;
    }
    const deferredForPrice = best !== null && earliest !== null && best.start > earliest.start;
    const chosenWindow = windows.find((window) => window.start <= chosen.start && chosen.start < window.end);
    preferredRuns.set(device.id, {
      device,
      start: chosen.start,
      end: chosen.end,
      windowEnd: chosenWindow ? chosenWindow.end : horizonEnd,
      caps: [],
      startReason:
        device.loadClass === "deferrable" && deferredForPrice
          ? "分时电价低谷时段启动"
          : "开放时段开始，按访客计划启动",
      stopReason: "会话结束，按计划停机",
      continued: false,
    });
  }

  // 启停依赖：按逆拓扑序（依赖方先处理）把运行覆盖需求传递给被依赖设备。
  // 被依赖设备不得晚于依赖方启动，且需等依赖方停机并留足顺序关机时长后才停机。
  const ordered = dependencyOrder(input.devices);
  const requiredStart = new Map<string, number>();
  const requiredEnd = new Map<string, number>();
  for (const device of [...ordered].reverse()) {
    const own = preferredRuns.get(device.id);
    const reqStart = requiredStart.get(device.id);
    const reqEnd = requiredEnd.get(device.id);
    let start = own?.start ?? reqStart ?? null;
    let end = own?.end ?? reqEnd ?? null;
    if (start === null || end === null) {
      continue;
    }
    if (reqStart !== undefined && reqStart < start) {
      start = reqStart;
    }
    if (reqEnd !== undefined && reqEnd > end) {
      end = reqEnd;
    }
    if (own?.continued !== true && start < horizonStart) {
      // 依赖需求追溯到过去：无法补开，立即在下一时槽启动并告警。
      warnings.push(`设备 ${device.id} 被依赖设备需要但当前未运行，已安排在下一时槽立即启动`);
      start = horizonStart;
    }
    const windows = allowedWindows(device);
    const container = windows.find((window) => window.start <= start && start < window.end);
    if (container && end > container.end) {
      warnings.push(`设备 ${device.id} 的依赖运行需求超出开放时段，已截断至闭馆时刻`);
      end = container.end;
    }
    const run: Run = own ?? {
      device,
      start,
      end,
      windowEnd: container ? container.end : horizonEnd,
      caps: [],
      startReason: "依赖设备需要，提前启动",
      stopReason: "会话结束，按计划停机",
      continued: false,
    };
    if (reqStart !== undefined && own && reqStart < own.start) {
      run.startReason = "依赖设备需要，提前启动";
    }
    if (reqEnd !== undefined && (own === undefined || reqEnd > own.end)) {
      run.stopReason = "顺序关机：等待依赖设备完成关机";
    }
    run.start = start;
    run.end = end;
    if (container) {
      run.windowEnd = container.end;
    }
    preferredRuns.set(device.id, run);
    for (const required of device.requires) {
      const requiredDevice = devicesById.get(required);
      if (!requiredDevice || requiredDevice.continuous || !isSchedulable(requiredDevice)) {
        continue;
      }
      requiredStart.set(required, Math.min(requiredStart.get(required) ?? start, start));
      requiredEnd.set(required, Math.max(requiredEnd.get(required) ?? end, end + device.shutdownMinutes * MINUTE_MS));
    }
  }

  const activeRuns = [...preferredRuns.values()];

  const capAt = (run: Run, at: number): number | null => {
    let cap: number | null = null;
    for (const event of run.caps) {
      if (event.at <= at) {
        cap = event.kw;
      }
    }
    return cap;
  };
  const runKwAt = (run: Run, at: number): number => {
    if (at < run.start || at >= run.end) {
      return 0;
    }
    const kw = curveKwAt(run.device, (at - run.start) / MINUTE_MS);
    const cap = capAt(run, at);
    return cap === null ? kw : Math.min(kw, cap);
  };
  const computeLoads = (): number[] => {
    const loads = baseline.slice();
    for (const run of activeRuns) {
      for (let index = 0; index < slotCount; index += 1) {
        loads[index] = loads[index]! + runKwAt(run, slotAt(index));
      }
    }
    return loads;
  };

  let loads = computeLoads();

  // 限额执行：仅重排非关键（可延迟）负荷——先降载，再延迟启动，最后提前关停。
  // 被其他运行中设备依赖的设备不得削减，避免破坏启停依赖。
  const hallPriority = (device: DeviceConfig): number => hallsById.get(device.hallId)?.priority ?? 0;
  const isRequiredAt = (run: Run, at: number): boolean =>
    activeRuns.some(
      (other) =>
        other !== run &&
        other.device.requires.includes(run.device.id) &&
        other.start <= at &&
        at < other.end + other.device.shutdownMinutes * MINUTE_MS,
    );
  for (let index = 0; index < slotCount; index += 1) {
    const at = slotAt(index);
    let over = loads[index]! - limitAt(at).maxKw;
    let guard = 0;
    while (over > 1e-9 && guard < 64) {
      guard += 1;
      const victims = activeRuns
        .filter(
          (run) =>
            isCurtailable(run.device) &&
            run.start <= at &&
            at < run.end &&
            runKwAt(run, at) > 1e-9 &&
            !isRequiredAt(run, at),
        )
        .sort(
          (a, b) =>
            hallPriority(b.device) - hallPriority(a.device) ||
            runKwAt(b, at) - runKwAt(a, at) ||
            a.device.id.localeCompare(b.device.id),
        );
      let acted = false;
      for (const victim of victims) {
        const currentKw = runKwAt(victim, at);
        // 1) 可降载则降载
        if (
          victim.device.reducibleToKw !== null &&
          victim.device.reducibleToKw < currentKw &&
          capAt(victim, at) === null
        ) {
          victim.caps.push({ at, kw: victim.device.reducibleToKw });
          acted = true;
          break;
        }
        // 2) 尚未启动则尝试在开放窗口内顺延
        if (victim.start >= horizonStart && !victim.continued) {
          if (shiftRun(victim, loads, slotMs, horizonStart, horizonEnd, limitAt)) {
            victim.startReason = "限额削峰，延迟启动避让峰值";
            acted = true;
            break;
          }
        }
        // 3) 满足最短运行时间则提前关停
        const earliestStop = victim.start + victim.device.minRunMinutes * MINUTE_MS;
        if (at >= earliestStop) {
          victim.end = at;
          victim.stopReason = "限额削峰，提前关停";
          victim.caps.push({ at, kw: null });
          acted = true;
          break;
        }
      }
      if (!acted) {
        break;
      }
      loads = computeLoads();
      over = loads[index]! - limitAt(at).maxKw;
    }
    if (over > 1e-9) {
      warnings.push(
        `时段 ${new Date(at).toISOString()} 预计超出限额 ${over.toFixed(1)}kW：非关键负荷已全部削减，保护类负荷不受影响`,
      );
    }
  }

  // 生成可执行动作。进行中会话补发其原始启动条目（时间在过去），
  // 供期望状态推断与命令去重使用；只有未来动作会被真正下发。
  const entries: PlannedAction[] = [];
  const entryId = (deviceId: string, action: CommandAction, at: number, targetKw: number | null): string =>
    `entry_${deviceId}_${action}_${at}${targetKw === null ? "" : `_${targetKw}`}`;
  for (const run of activeRuns) {
    if (run.continued || (run.start >= horizonStart && run.start < horizonEnd)) {
      entries.push({
        entryId: entryId(run.device.id, "start", run.start, null),
        deviceId: run.device.id,
        action: "start",
        at: run.start,
        reason: run.startReason,
        targetKw: null,
      });
    }
    for (const cap of run.caps) {
      if (cap.at < horizonStart || cap.at >= run.end || cap.kw === null) {
        continue;
      }
      entries.push({
        entryId: entryId(run.device.id, "reduce", cap.at, cap.kw),
        deviceId: run.device.id,
        action: "reduce",
        at: cap.at,
        reason: `限额 ${limitAt(cap.at).maxKw}kW 削峰，降载至 ${cap.kw}kW`,
        targetKw: cap.kw,
      });
    }
    if (run.end >= horizonStart && run.end <= horizonEnd) {
      entries.push({
        entryId: entryId(run.device.id, "stop", run.end, null),
        deviceId: run.device.id,
        action: "stop",
        at: run.end,
        reason: run.stopReason,
        targetKw: null,
      });
    }
  }
  entries.sort((a, b) => a.at - b.at || a.entryId.localeCompare(b.entryId));

  // 展厅峰值额度分配：保护类负荷先行扣除，剩余容量按批准优先级稳定分配。
  const hallLoads = new Map<string, number[]>();
  for (const [hallId, arr] of baselineByHall) {
    hallLoads.set(hallId, arr.slice());
  }
  for (const run of activeRuns) {
    const arr = hallArray(hallLoads, run.device.hallId);
    for (let index = 0; index < slotCount; index += 1) {
      arr[index] = arr[index]! + runKwAt(run, slotAt(index));
    }
  }
  const allocations: HallAllocation[] = [];
  interface WindowGroup {
    id: string;
    start: number;
    end: number;
    slots: number[];
  }
  const groups: WindowGroup[] = [];
  for (let index = 0; index < slotCount; index += 1) {
    const at = slotAt(index);
    const info = limitAt(at);
    const last = groups[groups.length - 1];
    if (last && last.id === info.id) {
      last.end = at + slotMs;
      last.slots.push(index);
    } else {
      groups.push({ id: info.id, start: at, end: at + slotMs, slots: [index] });
    }
  }
  for (const group of groups) {
    const demanded = new Map<string, number>();
    const allocated = new Map<string, number>();
    for (const index of group.slots) {
      const at = slotAt(index);
      const capacity = Math.max(0, limitAt(at).maxKw - protectedLoad[index]!);
      const requests = input.halls.map((hall) => {
        const total = hallLoads.get(hall.id)?.[index] ?? 0;
        const protectedPart = protectedByHall.get(hall.id)?.[index] ?? 0;
        return { hallId: hall.id, priority: hall.priority, demandedKw: Math.max(0, total - protectedPart) };
      });
      const grants = allocateStable(requests, capacity);
      for (const grant of grants) {
        const protectedPart = protectedByHall.get(grant.hallId)?.[index] ?? 0;
        const total = hallLoads.get(grant.hallId)?.[index] ?? 0;
        demanded.set(grant.hallId, Math.max(demanded.get(grant.hallId) ?? 0, total));
        allocated.set(grant.hallId, Math.max(allocated.get(grant.hallId) ?? 0, protectedPart + grant.allocatedKw));
      }
    }
    for (const hallId of [...demanded.keys()].sort()) {
      const demand = demanded.get(hallId) ?? 0;
      if (demand <= 1e-9) {
        continue;
      }
      allocations.push({
        limitWindowId: group.id,
        windowStart: group.start,
        windowEnd: group.end,
        hallId,
        demandedKw: round3(demand),
        allocatedKw: round3(allocated.get(hallId) ?? 0),
      });
    }
  }

  return {
    horizonStart,
    horizonEnd,
    entries,
    allocations,
    forecast: loads.map((kw, index) => ({
      at: slotAt(index),
      kw: round3(kw),
      limitKw: limitAt(slotAt(index)).maxKw,
    })),
    warnings,
  };
}

/** 在开放窗口内为运行寻找第一个满足限额的顺延位置；找不到返回 false。 */
function shiftRun(
  run: Run,
  loads: number[],
  slotMs: number,
  horizonStart: number,
  horizonEnd: number,
  limitAt: (at: number) => LimitInfo,
): boolean {
  const length = run.end - run.start;
  const slotIndex = (at: number): number => Math.round((at - horizonStart) / slotMs);
  const bound = Math.min(run.windowEnd, horizonEnd);
  for (let start = run.start + slotMs; start + length <= bound; start += slotMs) {
    let fits = true;
    for (let at = start; at < start + length; at += slotMs) {
      const index = slotIndex(at);
      if (index < 0 || index >= loads.length) {
        fits = false;
        break;
      }
      const currentOffset = (at - run.start) / MINUTE_MS;
      const existing = at >= run.start && at < run.end ? curveKwAt(run.device, currentOffset) : 0;
      const movedKw = curveKwAt(run.device, (at - start) / MINUTE_MS);
      if (loads[index]! - existing + movedKw > limitAt(at).maxKw + 1e-9) {
        fits = false;
        break;
      }
    }
    if (fits) {
      run.start = start;
      run.end = start + length;
      run.caps = run.caps.filter((cap) => cap.at >= run.start && cap.at < run.end);
      return true;
    }
  }
  return false;
}

/** 计划在某时刻对设备的期望状态，供补偿逻辑对照已下发命令。 */
export function desiredStateAt(
  entries: PlannedAction[],
  deviceId: string,
  at: number,
): { running: boolean; cappedKw: number | null } {
  let running = false;
  let cappedKw: number | null = null;
  for (const entry of entries) {
    if (entry.deviceId !== deviceId || entry.at > at) {
      continue;
    }
    if (entry.action === "start") {
      running = true;
      cappedKw = null;
    } else if (entry.action === "stop") {
      running = false;
      cappedKw = null;
    } else if (entry.action === "reduce") {
      cappedKw = entry.targetKw;
    } else if (entry.action === "restore") {
      cappedKw = null;
    }
  }
  return { running, cappedKw };
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
