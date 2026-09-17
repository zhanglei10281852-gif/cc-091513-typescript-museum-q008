import type {
  Command,
  Decision,
  DeviceConfig,
  HallConfig,
  IssuedCommand,
  LimitWindow,
  ManualOverride,
  Plan,
  Receipt,
  Settings,
  StoredReading,
  TariffWindow,
} from "./types.js";
import { DEFAULT_SETTINGS } from "./types.js";

/**
 * 事件溯源：所有状态变更先写入日志再应用到内存状态。
 * 进程恢复时重放日志即可还原计划、命令、回执、遥测与接管状态，
 * 原计划的计时（绝对时间戳）与补偿逻辑因此得以继续。
 */

export type Event =
  | { type: "config_loaded"; at: number; halls: HallConfig[]; devices: DeviceConfig[]; tariff: TariffWindow[]; settings: Settings }
  | { type: "limit_set"; at: number; limit: LimitWindow }
  | { type: "plan_committed"; at: number; plan: Plan }
  | { type: "command_issued"; at: number; command: Command }
  | { type: "command_compensated"; at: number; commandId: string; compensatedBy: string }
  | { type: "receipt_recorded"; at: number; receipt: Receipt }
  | { type: "telemetry_recorded"; at: number; reading: StoredReading }
  | { type: "telemetry_missing"; at: number; deviceId: string }
  | { type: "telemetry_recovered"; at: number; deviceId: string }
  | { type: "override_set"; at: number; override: ManualOverride }
  | { type: "override_expired"; at: number; overrideId: string }
  | { type: "override_released"; at: number; overrideId: string }
  | { type: "device_unresponsive"; at: number; deviceId: string; commandId: string }
  | { type: "device_responsive"; at: number; deviceId: string }
  | { type: "decision_logged"; at: number; decision: Decision };

export interface State {
  config: {
    halls: Record<string, HallConfig>;
    devices: Record<string, DeviceConfig>;
    tariff: TariffWindow[];
    limits: LimitWindow[];
    settings: Settings;
  };
  /** 当前生效计划；旧计划整体被取代（计划条目未下发的部分随之失效）。 */
  plan: Plan | null;
  planVersion: number;
  /** 已下发命令台账，按命令标识索引；命令不可变。 */
  commands: Record<string, IssuedCommand>;
  /** 设备回执，按命令标识去重。 */
  receipts: Record<string, Receipt>;
  /** 原始遥测读数（保留原始值，按设备分组）。 */
  telemetry: Record<string, StoredReading[]>;
  overrides: Record<string, ManualOverride>;
  /** 未响应设备：deviceId → 最早未回执命令。 */
  unresponsive: Record<string, { commandId: string; since: number }>;
  /** 遥测缺失起始时刻。 */
  telemetryMissing: Record<string, number>;
  /** 决策日志（延迟/关停/补偿等原因），供主管查看。 */
  decisions: Decision[];
  /** 上次计划对应的时槽起点，用于跨时槽自动重排。 */
  lastPlanSlot: number;
  seq: number;
}

export function initialState(): State {
  return {
    config: {
      halls: {},
      devices: {},
      tariff: [],
      limits: [],
      settings: { ...DEFAULT_SETTINGS },
    },
    plan: null,
    planVersion: 0,
    commands: {},
    receipts: {},
    telemetry: {},
    overrides: {},
    unresponsive: {},
    telemetryMissing: {},
    decisions: [],
    lastPlanSlot: 0,
    seq: 0,
  };
}

const MAX_DECISIONS = 500;
const MAX_READINGS_PER_DEVICE = 5000;

export function applyEvent(state: State, event: Event): void {
  state.seq += 1;
  switch (event.type) {
    case "config_loaded": {
      state.config.halls = Object.fromEntries(event.halls.map((hall) => [hall.id, hall]));
      state.config.devices = Object.fromEntries(event.devices.map((device) => [device.id, device]));
      state.config.tariff = event.tariff;
      state.config.settings = event.settings;
      state.plan = null;
      state.lastPlanSlot = 0;
      break;
    }
    case "limit_set": {
      state.config.limits = [...state.config.limits.filter((limit) => limit.id !== event.limit.id), event.limit];
      break;
    }
    case "plan_committed": {
      state.plan = event.plan;
      state.planVersion = event.plan.version;
      state.lastPlanSlot = event.plan.horizonStart;
      break;
    }
    case "command_issued": {
      // 事件序号即下发顺序，重放时按日志顺序自然还原。
      state.commands[event.command.id] = { ...event.command, seq: state.seq };
      break;
    }
    case "command_compensated": {
      const command = state.commands[event.commandId];
      if (command) {
        command.compensatedBy = event.compensatedBy;
      }
      break;
    }
    case "receipt_recorded": {
      state.receipts[event.receipt.commandId] = event.receipt;
      break;
    }
    case "telemetry_recorded": {
      const list = state.telemetry[event.reading.deviceId] ?? [];
      list.push(event.reading);
      list.sort((a, b) => a.at - b.at || a.receivedAt - b.receivedAt);
      if (list.length > MAX_READINGS_PER_DEVICE) {
        list.splice(0, list.length - MAX_READINGS_PER_DEVICE);
      }
      state.telemetry[event.reading.deviceId] = list;
      break;
    }
    case "telemetry_missing": {
      state.telemetryMissing[event.deviceId] = event.at;
      break;
    }
    case "telemetry_recovered": {
      delete state.telemetryMissing[event.deviceId];
      break;
    }
    case "override_set": {
      state.overrides[event.override.id] = event.override;
      break;
    }
    case "override_expired":
    case "override_released": {
      const override = state.overrides[event.overrideId];
      if (override && override.releasedAt === null) {
        override.releasedAt = event.at;
      }
      break;
    }
    case "device_unresponsive": {
      state.unresponsive[event.deviceId] = { commandId: event.commandId, since: event.at };
      break;
    }
    case "device_responsive": {
      delete state.unresponsive[event.deviceId];
      break;
    }
    case "decision_logged": {
      state.decisions.push(event.decision);
      if (state.decisions.length > MAX_DECISIONS) {
        state.decisions.splice(0, state.decisions.length - MAX_DECISIONS);
      }
      break;
    }
  }
}
