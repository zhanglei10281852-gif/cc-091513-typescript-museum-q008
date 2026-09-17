/**
 * 领域核心类型。所有时间戳均为 epoch 毫秒，功率单位为 kW。
 * 枚举取值与 reference/domain.json 保持一致。
 */

export type LoadClass = "life_safety" | "collection_protection" | "visitor_critical" | "deferrable";
export type CommandAction = "start" | "reduce" | "stop" | "restore";
export type TelemetryQuality = "good" | "late" | "missing" | "invalid";
export type ReceiptStatus = "accepted" | "completed" | "rejected";
export type OverrideMode = "force_on" | "force_off" | "hold";

export const LOAD_CLASSES: readonly LoadClass[] = [
  "life_safety",
  "collection_protection",
  "visitor_critical",
  "deferrable",
];
export const COMMAND_ACTIONS: readonly CommandAction[] = ["start", "reduce", "stop", "restore"];
export const TELEMETRY_QUALITIES: readonly TelemetryQuality[] = ["good", "late", "missing", "invalid"];

/** 功率曲线采样点：从启动时刻起的偏移分钟数 → 期望功率。 */
export interface PowerCurvePoint {
  offsetMinutes: number;
  kw: number;
}

export interface DeviceConfig {
  id: string;
  hallId: string;
  name: string;
  loadClass: LoadClass;
  ratedPowerKw: number;
  /** 运行期功率曲线；为空时按额定功率常量处理。 */
  curve: PowerCurvePoint[];
  /** 单次会话典型运行时长（分钟）。 */
  runMinutes: number;
  /** 一旦启动的最短运行时间（分钟），避免频繁启停损伤设备。 */
  minRunMinutes: number;
  /** 顺序关机所需提前量（分钟）：依赖它的设备停机后，需等待该时长才允许自身停机。 */
  shutdownMinutes: number;
  /** 启动前必须已在运行的设备标识。 */
  requires: string[];
  /** 支持降载到的最小功率；null 表示不可降载。 */
  reducibleToKw: number | null;
  /** 连续运行负荷（如恒温展示柜、生命安全设备），不参与排程，始终计入基线。 */
  continuous: boolean;
}

/** 开放时段，epoch 毫秒区间 [start, end)。 */
export interface OpenWindow {
  start: number;
  end: number;
}

export interface HallConfig {
  id: string;
  name: string;
  /** 批准优先级：数值越小越优先获得峰值额度。 */
  priority: number;
  openWindows: OpenWindow[];
}

/** 分时电价窗口。 */
export interface TariffWindow {
  start: number;
  end: number;
  pricePerKwh: number;
}

/** 园区限额（削峰通知），[start, end) 内站点总负荷不得超过 maxKw。 */
export interface LimitWindow {
  id: string;
  start: number;
  end: number;
  maxKw: number;
  reason: string;
}

export interface Settings {
  /** 排程时槽粒度（分钟）。 */
  slotMinutes: number;
  /** 计量窗口（分钟），迟到读数按事件时间归入对应窗口。 */
  meteringWindowMinutes: number;
  /** 命令下发后等待回执的超时（分钟），超时标记设备未响应。 */
  ackTimeoutMinutes: number;
  /** 遥测静默超时（分钟），超时按缺失处理并触发重排。 */
  telemetryTimeoutMinutes: number;
  /** 计划时域（小时）。 */
  horizonHours: number;
  /** 无电价窗口覆盖时的默认电价。 */
  defaultPricePerKwh: number;
  /** 无限额窗口覆盖时的默认站点限额。 */
  defaultLimitKw: number;
}

export const DEFAULT_SETTINGS: Settings = {
  slotMinutes: 5,
  meteringWindowMinutes: 15,
  ackTimeoutMinutes: 2,
  telemetryTimeoutMinutes: 3,
  horizonHours: 12,
  defaultPricePerKwh: 0.6,
  defaultLimitKw: 250,
};

/** 计划中的一条可执行动作。entryId 由内容决定，保证重排幂等。 */
export interface PlannedAction {
  entryId: string;
  deviceId: string;
  action: CommandAction;
  at: number;
  reason: string;
  targetKw: number | null;
}

/** 展厅在某个限额窗口内获得的峰值额度分配。 */
export interface HallAllocation {
  limitWindowId: string;
  windowStart: number;
  windowEnd: number;
  hallId: string;
  demandedKw: number;
  allocatedKw: number;
}

/** 负荷预测点。 */
export interface ForecastPoint {
  at: number;
  kw: number;
  limitKw: number;
}

export interface Plan {
  version: number;
  createdAt: number;
  horizonStart: number;
  horizonEnd: number;
  entries: PlannedAction[];
  allocations: HallAllocation[];
  forecast: ForecastPoint[];
  warnings: string[];
}

/** 已下发命令。命令不可变，撤销只能通过补偿命令（supersedes 指向原命令）。 */
export interface Command {
  id: string;
  deviceId: string;
  action: CommandAction;
  at: number;
  issuedAt: number;
  reason: string;
  planVersion: number;
  targetKw: number | null;
  supersedes: string | null;
  compensatedBy: string | null;
}

/** 台账中的命令：附带事件序号，折叠设备状态时以下发顺序（而非计划时刻）为准。 */
export type IssuedCommand = Command & { seq: number };

export interface Receipt {
  commandId: string;
  deviceId: string;
  status: ReceiptStatus;
  at: number;
  detail: string | null;
}

export interface StoredReading {
  deviceId: string;
  kw: number;
  /** 事件时间（读数实际产生时刻），计量窗口按它归属。 */
  at: number;
  /** 到达时间。 */
  receivedAt: number;
  quality: TelemetryQuality;
}

export interface ManualOverride {
  id: string;
  deviceId: string;
  mode: OverrideMode;
  reason: string;
  createdBy: string;
  createdAt: number;
  /** 手动接管必须有有效期。 */
  expiresAt: number;
  releasedAt: number | null;
}

export interface Decision {
  at: number;
  kind: string;
  deviceId: string | null;
  reason: string;
}
