import { curveKwAt, isProtected } from "./devices.js";
import { applyEvent, initialState, type Event, type State } from "./events.js";
import { desiredStateAt, plan, type AssumedState } from "./planner.js";
import { latestReading, makeStoredReading } from "./telemetry.js";
import { floorTo, MINUTE_MS, ValidationError } from "./time.js";
import type {
  Command,
  CommandAction,
  Decision,
  DeviceConfig,
  HallConfig,
  IssuedCommand,
  LimitWindow,
  ManualOverride,
  OverrideMode,
  Plan,
  Receipt,
  ReceiptStatus,
  Settings,
  TariffWindow,
} from "./types.js";

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/** 事件日志：先写日志再应用，保证进程恢复后可重放。 */
export interface Journal {
  append(event: Event): void;
}

export interface EffectiveState {
  running: boolean;
  cappedKw: number | null;
  runningSince: number | null;
  lastCommandId: string | null;
}

export class Orchestrator {
  readonly state: State;
  private readonly clock: Clock;
  private readonly journal: Journal | null;
  private dirty = true;

  constructor(deps: { clock: Clock; journal?: Journal | null; state?: State }) {
    this.clock = deps.clock;
    this.journal = deps.journal ?? null;
    this.state = deps.state ?? initialState();
  }

  /** 进程恢复：重放事件日志还原状态，原计划的绝对计时与补偿链随之恢复。 */
  static replay(events: Event[], deps: { clock: Clock; journal?: Journal | null }): Orchestrator {
    const orchestrator = new Orchestrator(deps);
    for (const event of events) {
      applyEvent(orchestrator.state, event);
    }
    return orchestrator;
  }

  private emit(event: Event): void {
    this.journal?.append(event);
    applyEvent(this.state, event);
  }

  private logDecision(at: number, kind: string, deviceId: string | null, reason: string): void {
    this.emit({ type: "decision_logged", at, decision: { at, kind, deviceId, reason } });
  }

  // ---------------------------------------------------------------- 配置与输入

  loadConfig(config: {
    halls: HallConfig[];
    devices: DeviceConfig[];
    tariff: TariffWindow[];
    settings: Settings;
  }): void {
    const now = this.clock.now();
    this.emit({
      type: "config_loaded",
      at: now,
      halls: config.halls,
      devices: config.devices,
      tariff: config.tariff,
      settings: config.settings,
    });
    this.logDecision(now, "config", null, "运行配置已加载，重新生成计划");
    this.dirty = true;
    this.evaluate();
  }

  /** 收到园区限额（削峰通知）：记录后立即重排非关键负荷。 */
  setLimit(limit: LimitWindow): LimitWindow {
    const now = this.clock.now();
    this.emit({ type: "limit_set", at: now, limit });
    this.logDecision(
      now,
      "limit",
      null,
      `限额调整：${new Date(limit.start).toISOString()} 起 ${limit.maxKw}kW（${limit.reason}），重新安排非关键负荷`,
    );
    this.dirty = true;
    this.evaluate();
    return limit;
  }

  ingestTelemetry(readings: { deviceId: string; kw: number; at: number }[]): {
    deviceId: string;
    at: number;
    quality: string;
  }[] {
    const now = this.clock.now();
    const windowMinutes = this.state.config.settings.meteringWindowMinutes;
    const results = readings.map((reading) => {
      if (!this.state.config.devices[reading.deviceId]) {
        throw new ValidationError(`未知设备 ${reading.deviceId}`, "unknown_device");
      }
      const stored = makeStoredReading(reading, now, windowMinutes);
      this.emit({ type: "telemetry_recorded", at: now, reading: stored });
      return { deviceId: stored.deviceId, at: stored.at, quality: stored.quality };
    });
    this.evaluate();
    return results;
  }

  /** 设备回执：按命令标识去重，重复回执直接返回首次记录。 */
  recordReceipt(input: { commandId: string; status: ReceiptStatus; detail?: string | null }): {
    deduplicated: boolean;
    receipt: Receipt;
  } {
    const now = this.clock.now();
    const command = this.state.commands[input.commandId];
    if (!command) {
      throw new ValidationError(`未知命令 ${input.commandId}`, "unknown_command");
    }
    const existing = this.state.receipts[input.commandId];
    if (existing) {
      return { deduplicated: true, receipt: existing };
    }
    const receipt: Receipt = {
      commandId: input.commandId,
      deviceId: command.deviceId,
      status: input.status,
      at: now,
      detail: input.detail ?? null,
    };
    this.emit({ type: "receipt_recorded", at: now, receipt });
    const pending = this.state.unresponsive[command.deviceId];
    if (pending && pending.commandId === input.commandId) {
      this.emit({ type: "device_responsive", at: now, deviceId: command.deviceId });
      this.logDecision(now, "unresponsive", command.deviceId, `设备恢复响应，命令 ${input.commandId} 已回执`);
    }
    if (input.status === "rejected") {
      this.logDecision(now, "command", command.deviceId, `命令 ${input.commandId} 被设备拒绝，重新安排非关键负荷`);
      this.dirty = true;
    }
    this.evaluate();
    return { deduplicated: false, receipt };
  }

  /** 手动接管：必须有未来的有效期；生命安全和藏品保护设备不得被关停。 */
  setOverride(input: {
    deviceId: string;
    mode: OverrideMode;
    reason: string;
    createdBy: string;
    expiresAt: number;
  }): ManualOverride {
    const now = this.clock.now();
    const device = this.state.config.devices[input.deviceId];
    if (!device) {
      throw new ValidationError(`未知设备 ${input.deviceId}`, "unknown_device");
    }
    if (!Number.isFinite(input.expiresAt) || input.expiresAt <= now) {
      throw new ValidationError("手动接管必须设置未来的有效期", "override_expiry_required");
    }
    if (input.mode === "force_off" && isProtected(device.loadClass)) {
      throw new ValidationError(
        `设备 ${input.deviceId} 属于 ${device.loadClass}，生命安全与藏品保护负荷不得被削减`,
        "protected_device",
      );
    }
    const override: ManualOverride = {
      id: `ovr_${this.state.seq + 1}`,
      deviceId: input.deviceId,
      mode: input.mode,
      reason: input.reason,
      createdBy: input.createdBy,
      createdAt: now,
      expiresAt: input.expiresAt,
      releasedAt: null,
    };
    // 同一设备已有生效中的接管时，新接管取代旧接管。
    for (const existing of Object.values(this.state.overrides)) {
      if (existing.deviceId === input.deviceId && existing.releasedAt === null) {
        this.emit({ type: "override_released", at: now, overrideId: existing.id });
      }
    }
    this.emit({ type: "override_set", at: now, override });
    this.logDecision(
      now,
      "override",
      input.deviceId,
      `手动接管（${input.mode}）：${input.reason}，有效期至 ${new Date(input.expiresAt).toISOString()}`,
    );
    this.dirty = true;
    this.evaluate();
    return override;
  }

  releaseOverride(overrideId: string): void {
    const now = this.clock.now();
    const override = this.state.overrides[overrideId];
    if (!override || override.releasedAt !== null) {
      throw new ValidationError(`接管 ${overrideId} 不存在或已结束`, "unknown_override");
    }
    this.emit({ type: "override_released", at: now, overrideId });
    this.logDecision(now, "override", override.deviceId, `手动接管提前解除：${override.reason}`);
    this.dirty = true;
    this.evaluate();
  }

  recompute(): void {
    this.dirty = true;
    this.evaluate();
  }

  // ---------------------------------------------------------------- 主循环

  /**
   * 主循环：处理接管到期、遥测缺失、设备未响应，按需重排计划，
   * 下发到期命令并对已下发命令做补偿。进程恢复后调用本方法即可继续原计划计时。
   */
  evaluate(now: number = this.clock.now()): void {
    const settings = this.state.config.settings;

    // 1) 手动接管到期自动解除
    for (const override of Object.values(this.state.overrides)) {
      if (override.releasedAt === null && override.expiresAt <= now) {
        this.emit({ type: "override_expired", at: now, overrideId: override.id });
        this.logDecision(now, "override", override.deviceId, `手动接管到期（${override.mode}），恢复自动编排`);
        this.dirty = true;
      }
    }

    // 2) 遥测缺失检测：有过读数或命令的设备静默超时即标记，触发保守重排
    const telemetryTimeoutMs = settings.telemetryTimeoutMinutes * MINUTE_MS;
    for (const device of Object.values(this.state.config.devices)) {
      const readings = this.state.telemetry[device.id];
      const hasHistory = (readings && readings.length > 0) || this.deviceCommands(device.id).length > 0;
      if (!hasHistory) {
        continue;
      }
      const latest = readings ? latestReading(readings, device.id) : null;
      const stale = !latest || now - latest.at > telemetryTimeoutMs;
      const missing = this.state.telemetryMissing[device.id] !== undefined;
      if (stale && !missing) {
        this.emit({ type: "telemetry_missing", at: now, deviceId: device.id });
        this.logDecision(now, "telemetry", device.id, "遥测缺失，按最近已知状态保守估计负荷并重排非关键负荷");
        this.dirty = true;
      } else if (!stale && missing) {
        this.emit({ type: "telemetry_recovered", at: now, deviceId: device.id });
        this.logDecision(now, "telemetry", device.id, "遥测恢复");
        this.dirty = true;
      }
    }

    // 3) 未响应设备：命令超时未回执
    const ackTimeoutMs = settings.ackTimeoutMinutes * MINUTE_MS;
    for (const command of Object.values(this.state.commands)) {
      if (this.state.receipts[command.id] || command.compensatedBy !== null) {
        continue;
      }
      if (now - command.issuedAt <= ackTimeoutMs) {
        continue;
      }
      if (!this.state.unresponsive[command.deviceId]) {
        this.emit({ type: "device_unresponsive", at: now, deviceId: command.deviceId, commandId: command.id });
        this.logDecision(now, "unresponsive", command.deviceId, `命令 ${command.id} 超时未回执，按未执行保守处理`);
        this.dirty = true;
      }
    }

    // 4) 按需重排：输入变化或跨时槽
    const slotMs = settings.slotMinutes * MINUTE_MS;
    const slotBoundaryCrossed = this.state.plan !== null && floorTo(now, slotMs) >= this.state.plan.horizonStart;
    if (this.dirty || this.state.plan === null || slotBoundaryCrossed) {
      this.commitPlan(now);
      this.dirty = false;
    }

    // 5) 下发到期命令（含恢复期间到期的命令，继续原计划计时）
    const planNow = this.state.plan;
    if (planNow) {
      for (const entry of planNow.entries) {
        if (entry.at > now) {
          continue;
        }
        const commandId = `cmd_${entry.entryId.slice("entry_".length)}`;
        if (this.state.commands[commandId]) {
          continue;
        }
        this.issueCommand(
          {
            id: commandId,
            deviceId: entry.deviceId,
            action: entry.action,
            at: entry.at,
            reason: entry.reason,
            targetKw: entry.targetKw,
          },
          now,
        );
      }
    }

    // 6) 补偿：已下发命令与当前计划期望状态冲突时，只能以补偿动作撤销
    this.compensate(now);
  }

  private commitPlan(now: number): void {
    const { config } = this.state;
    const assumed = new Map<string, AssumedState>();
    for (const device of Object.values(config.devices)) {
      const effective = this.effectiveState(device.id);
      assumed.set(device.id, {
        running: effective.running,
        runningSince: effective.runningSince,
        cappedKw: effective.cappedKw,
        lastStopAt: effective.lastStopAt,
      });
    }
    const output = plan({
      now,
      settings: config.settings,
      halls: Object.values(config.halls),
      devices: Object.values(config.devices),
      tariff: config.tariff,
      limits: config.limits,
      overrides: Object.values(this.state.overrides).filter(
        (override) => override.releasedAt === null && override.expiresAt > now,
      ),
      assumed,
    });
    const current = this.state.plan;
    // 计划是否变化只看执行内容（设备/动作/时刻/目标功率与额度），
    // 忽略原因措辞差异，保证恢复与跨时槽重排不产生无意义的新版本。
    const projection = (plan: { entries: Plan["entries"]; allocations: Plan["allocations"] }): string =>
      JSON.stringify({
        e: plan.entries.map((entry) => [entry.deviceId, entry.action, entry.at, entry.targetKw]),
        a: plan.allocations.map((alloc) => [
          alloc.limitWindowId,
          alloc.hallId,
          alloc.demandedKw,
          alloc.allocatedKw,
        ]),
      });
    const unchanged = current !== null && projection(current) === projection(output);
    if (unchanged) {
      return;
    }
    const committed: Plan = { version: this.state.planVersion + 1, createdAt: now, ...output };
    this.emit({ type: "plan_committed", at: now, plan: committed });
    for (const warning of output.warnings) {
      this.logDecision(now, "warning", null, warning);
    }
  }

  /** 下发命令；若与上一生效命令作用相反，则作为补偿动作关联原命令。 */
  private issueCommand(
    draft: { id: string; deviceId: string; action: CommandAction; at: number; reason: string; targetKw: number | null },
    now: number,
  ): Command | null {
    if (this.state.commands[draft.id]) {
      return null;
    }
    const effective = this.effectiveState(draft.deviceId);
    const reverses =
      (draft.action === "start" && effective.lastAction === "stop") ||
      (draft.action === "stop" && (effective.lastAction === "start" || effective.lastAction === "restore")) ||
      (draft.action === "restore" && effective.lastAction === "reduce") ||
      (draft.action === "reduce" && effective.lastAction === "restore");
    const supersedes = reverses ? effective.lastCommandId : null;
    const command: Command = {
      id: draft.id,
      deviceId: draft.deviceId,
      action: draft.action,
      at: draft.at,
      issuedAt: now,
      reason: draft.reason,
      planVersion: this.state.planVersion,
      targetKw: draft.targetKw,
      supersedes,
      compensatedBy: null,
    };
    this.emit({ type: "command_issued", at: now, command });
    if (supersedes) {
      this.emit({ type: "command_compensated", at: now, commandId: supersedes, compensatedBy: command.id });
      this.logDecision(now, "compensation", draft.deviceId, `补偿动作 ${command.id}（${command.action}）撤销已下发命令 ${supersedes}：${command.reason}`);
    } else {
      this.logDecision(now, "command", draft.deviceId, `下发命令 ${command.id}（${command.action}）：${command.reason}`);
    }
    return command;
  }

  /** 对照计划期望状态与已下发命令的实际效果，冲突时发出补偿命令。 */
  private compensate(now: number): void {
    const planNow = this.state.plan;
    if (!planNow) {
      return;
    }
    for (const device of Object.values(this.state.config.devices)) {
      if (device.continuous) {
        continue;
      }
      const effective = this.effectiveState(device.id);
      if (effective.lastCommandId === null) {
        continue;
      }
      const override = Object.values(this.state.overrides).find(
        (candidate) =>
          candidate.deviceId === device.id && candidate.releasedAt === null && candidate.expiresAt > now,
      );
      if (override?.mode === "hold") {
        continue;
      }
      let desired = desiredStateAt(planNow.entries, device.id, now);
      if (override?.mode === "force_on") {
        desired = { running: true, cappedKw: null };
      } else if (override?.mode === "force_off") {
        desired = { running: false, cappedKw: null };
      }
      if (isProtected(device.loadClass) && !desired.running) {
        desired = { ...desired, running: true };
      }
      if (desired.running === effective.running && desired.cappedKw === effective.cappedKw) {
        continue;
      }
      let action: CommandAction;
      let targetKw: number | null = null;
      if (!desired.running) {
        action = "stop";
      } else if (!effective.running) {
        action = "start";
      } else if (desired.cappedKw === null) {
        action = "restore";
      } else {
        action = "reduce";
        targetKw = desired.cappedKw;
      }
      const commandId = `cmd_${device.id}_${action}_${now}${targetKw === null ? "" : `_${targetKw}`}`;
      this.issueCommand(
        {
          id: commandId,
          deviceId: device.id,
          action,
          at: now,
          reason: `计划调整后撤销先前命令 ${effective.lastCommandId}，恢复与当前计划一致`,
          targetKw,
        },
        now,
      );
    }
  }

  // ---------------------------------------------------------------- 状态查询

  private deviceCommands(deviceId: string): IssuedCommand[] {
    // 以下发顺序（事件序号）折叠：同一时刻的多个命令，后下发者生效。
    return Object.values(this.state.commands)
      .filter((command) => command.deviceId === deviceId)
      .sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id));
  }

  /** 折叠设备全部已下发命令（含补偿链），得到当前生效状态。 */
  effectiveState(deviceId: string): EffectiveState & { lastAction: CommandAction | null; lastStopAt: number | null } {
    let running = false;
    let cappedKw: number | null = null;
    let runningSince: number | null = null;
    let lastCommandId: string | null = null;
    let lastAction: CommandAction | null = null;
    let lastStopAt: number | null = null;
    for (const command of this.deviceCommands(deviceId)) {
      if (command.action === "start") {
        running = true;
        cappedKw = null;
        runningSince = command.at;
      } else if (command.action === "stop") {
        running = false;
        cappedKw = null;
        runningSince = null;
        lastStopAt = command.at;
      } else if (command.action === "reduce") {
        cappedKw = command.targetKw;
      } else if (command.action === "restore") {
        cappedKw = null;
      }
      lastCommandId = command.id;
      lastAction = command.action;
    }
    return { running, cappedKw, runningSince, lastCommandId, lastAction, lastStopAt };
  }

  private activeOverride(deviceId: string, now: number): ManualOverride | null {
    return (
      Object.values(this.state.overrides).find(
        (override) =>
          override.deviceId === deviceId && override.releasedAt === null && override.expiresAt > now,
      ) ?? null
    );
  }

  /** 设备当前功率：优先新鲜遥测，缺失时按已下发命令保守估计。 */
  private deviceLoadKw(device: DeviceConfig, now: number): { kw: number; assumed: boolean } {
    const readings = this.state.telemetry[device.id];
    const latest = readings ? latestReading(readings, device.id) : null;
    const timeoutMs = this.state.config.settings.telemetryTimeoutMinutes * MINUTE_MS;
    if (latest && now - latest.at <= timeoutMs) {
      return { kw: latest.kw, assumed: false };
    }
    if (device.continuous) {
      return { kw: curveKwAt(device, 0), assumed: true };
    }
    const effective = this.effectiveState(device.id);
    if (!effective.running) {
      return { kw: 0, assumed: true };
    }
    const elapsed = effective.runningSince === null ? 0 : (now - effective.runningSince) / MINUTE_MS;
    const kw = curveKwAt(device, Math.max(0, elapsed));
    return { kw: effective.cappedKw === null ? kw : Math.min(kw, effective.cappedKw), assumed: true };
  }

  status(): Record<string, unknown> {
    const now = this.clock.now();
    const devices = Object.values(this.state.config.devices);
    let currentLoadKw = 0;
    const assumedDevices: string[] = [];
    for (const device of devices) {
      const load = this.deviceLoadKw(device, now);
      currentLoadKw += load.kw;
      if (load.assumed && (device.continuous || this.effectiveState(device.id).running)) {
        assumedDevices.push(device.id);
      }
    }
    const planNow = this.state.plan;
    let forecastPeak: { at: number; kw: number; limitKw: number } | null = null;
    if (planNow) {
      for (const point of planNow.forecast) {
        if (point.at < now) {
          continue;
        }
        if (!forecastPeak || point.kw > forecastPeak.kw) {
          forecastPeak = point;
        }
      }
    }
    const limitKw = this.limitAt(now);
    return {
      now,
      currentLoadKw: Math.round(currentLoadKw * 1000) / 1000,
      limitKw,
      assumedDevices,
      forecastPeak,
      plan: planNow
        ? {
            version: planNow.version,
            createdAt: planNow.createdAt,
            horizonStart: planNow.horizonStart,
            horizonEnd: planNow.horizonEnd,
            upcomingEntries: planNow.entries.filter((entry) => entry.at >= now),
            allocations: planNow.allocations,
            warnings: planNow.warnings,
          }
        : null,
      unresponsiveDevices: Object.entries(this.state.unresponsive).map(([deviceId, info]) => ({
        deviceId,
        commandId: info.commandId,
        since: info.since,
      })),
      missingTelemetry: Object.entries(this.state.telemetryMissing).map(([deviceId, since]) => ({
        deviceId,
        since,
      })),
      activeOverrides: Object.values(this.state.overrides).filter(
        (override) => override.releasedAt === null && override.expiresAt > now,
      ),
      recentDecisions: this.state.decisions.slice(-50),
    };
  }

  private limitAt(at: number): number {
    let best = this.state.config.settings.defaultLimitKw;
    for (const limit of this.state.config.limits) {
      if (limit.start <= at && at < limit.end && limit.maxKw <= best) {
        best = limit.maxKw;
      }
    }
    return best;
  }

  planView(): Plan | null {
    return this.state.plan;
  }

  commandsView(): (Command & { receipt: Receipt | null })[] {
    return Object.values(this.state.commands)
      .sort((a, b) => a.issuedAt - b.issuedAt || a.id.localeCompare(b.id))
      .map((command) => ({ ...command, receipt: this.state.receipts[command.id] ?? null }));
  }

  decisionsView(): Decision[] {
    return this.state.decisions;
  }

  configView(): State["config"] {
    return this.state.config;
  }

  /** 计量视图：读数按事件时间归窗，迟到读数修正其所属历史窗口。 */
  meteringView(from: number, to: number): Record<string, unknown>[] {
    const now = this.clock.now();
    const windowMinutes = this.state.config.settings.meteringWindowMinutes;
    const windowMs = windowMinutes * MINUTE_MS;
    const rows: Record<string, unknown>[] = [];
    for (const device of Object.values(this.state.config.devices)) {
      const readings = this.state.telemetry[device.id] ?? [];
      for (let windowStart = floorTo(from, windowMs); windowStart < to; windowStart += windowMs) {
        const windowEnd = windowStart + windowMs;
        const inWindow = readings.filter((reading) => reading.at >= windowStart && reading.at < windowEnd);
        const valid = inWindow.filter((reading) => reading.quality === "good" || reading.quality === "late");
        const invalid = inWindow.filter((reading) => reading.quality === "invalid").length;
        const late = inWindow.filter((reading) => reading.quality === "late").length;
        let quality: string;
        if (valid.length > 0) {
          quality = late > 0 ? "late" : "good";
        } else if (invalid > 0) {
          quality = "invalid";
        } else if (windowEnd <= now && readings.length > 0) {
          quality = "missing";
        } else {
          continue;
        }
        const avgKw =
          valid.length > 0
            ? Math.round((valid.reduce((sum, reading) => sum + reading.kw, 0) / valid.length) * 1000) / 1000
            : null;
        rows.push({
          deviceId: device.id,
          windowStart,
          windowEnd,
          avgKw,
          samples: valid.length,
          invalidSamples: invalid,
          lateSamples: late,
          quality,
        });
      }
    }
    return rows.sort((a, b) => (a["windowStart"] as number) - (b["windowStart"] as number));
  }
}
