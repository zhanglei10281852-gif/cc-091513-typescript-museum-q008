import { dependencyOrder } from "./devices.js";
import { parseTimestamp, ValidationError } from "./time.js";
import {
  DEFAULT_SETTINGS,
  LOAD_CLASSES,
  type DeviceConfig,
  type HallConfig,
  type LimitWindow,
  type OverrideMode,
  type PowerCurvePoint,
  type ReceiptStatus,
  type Settings,
  type TariffWindow,
} from "./types.js";

/** API 载荷解析与校验：非法输入抛出 ValidationError，由 HTTP 层映射为 4xx。 */

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ValidationError(`字段 ${field} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new ValidationError(`字段 ${field} 必须是数组`);
  }
  return value;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ValidationError(`字段 ${field} 必须是非空字符串`);
  }
  return value;
}

function asNumber(value: unknown, field: string, options: { min?: number; integer?: boolean } = {}): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ValidationError(`字段 ${field} 必须是有限数值`);
  }
  if (options.min !== undefined && value < options.min) {
    throw new ValidationError(`字段 ${field} 不得小于 ${options.min}`);
  }
  if (options.integer && !Number.isInteger(value)) {
    throw new ValidationError(`字段 ${field} 必须是整数`);
  }
  return value;
}

function optionalNumber(value: unknown, field: string, options: { min?: number } = {}): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  return asNumber(value, field, options);
}

function asEnum<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new ValidationError(`字段 ${field} 必须是 ${allowed.join("/")} 之一`);
  }
  return value as T;
}

function parseWindows(value: unknown, field: string): { start: number; end: number }[] {
  return asArray(value, field).map((item, index) => {
    const record = asRecord(item, `${field}[${index}]`);
    const start = parseTimestamp(record["start"], `${field}[${index}].start`);
    const end = parseTimestamp(record["end"], `${field}[${index}].end`);
    if (end <= start) {
      throw new ValidationError(`字段 ${field}[${index}] 的结束时间必须晚于开始时间`);
    }
    return { start, end };
  });
}

function parseCurve(value: unknown, field: string): PowerCurvePoint[] {
  if (value === undefined || value === null) {
    return [];
  }
  const points = asArray(value, field).map((item, index) => {
    const record = asRecord(item, `${field}[${index}]`);
    return {
      offsetMinutes: asNumber(record["offsetMinutes"], `${field}[${index}].offsetMinutes`, { min: 0 }),
      kw: asNumber(record["kw"], `${field}[${index}].kw`, { min: 0 }),
    };
  });
  points.sort((a, b) => a.offsetMinutes - b.offsetMinutes);
  return points;
}

export function parseDevice(value: unknown, index: number): DeviceConfig {
  const field = `devices[${index}]`;
  const record = asRecord(value, field);
  const device: DeviceConfig = {
    id: asString(record["id"], `${field}.id`),
    hallId: asString(record["hallId"], `${field}.hallId`),
    name: asString(record["name"], `${field}.name`),
    loadClass: asEnum(record["loadClass"], `${field}.loadClass`, LOAD_CLASSES),
    ratedPowerKw: asNumber(record["ratedPowerKw"], `${field}.ratedPowerKw`, { min: 0 }),
    curve: parseCurve(record["curve"], `${field}.curve`),
    runMinutes: asNumber(record["runMinutes"] ?? 60, `${field}.runMinutes`, { min: 1 }),
    minRunMinutes: asNumber(record["minRunMinutes"] ?? 0, `${field}.minRunMinutes`, { min: 0 }),
    shutdownMinutes: asNumber(record["shutdownMinutes"] ?? 0, `${field}.shutdownMinutes`, { min: 0 }),
    requires: record["requires"] === undefined ? [] : asArray(record["requires"], `${field}.requires`).map((item, i) => asString(item, `${field}.requires[${i}]`)),
    reducibleToKw: optionalNumber(record["reducibleToKw"], `${field}.reducibleToKw`, { min: 0 }),
    continuous: record["continuous"] === true,
  };
  if (device.reducibleToKw !== null && device.reducibleToKw > device.ratedPowerKw) {
    throw new ValidationError(`${field}.reducibleToKw 不得高于额定功率`);
  }
  return device;
}

export function parseHall(value: unknown, index: number): HallConfig {
  const field = `halls[${index}]`;
  const record = asRecord(value, field);
  return {
    id: asString(record["id"], `${field}.id`),
    name: asString(record["name"], `${field}.name`),
    priority: asNumber(record["priority"], `${field}.priority`, { min: 0, integer: true }),
    openWindows: parseWindows(record["openWindows"] ?? [], `${field}.openWindows`),
  };
}

export function parseTariff(value: unknown, index: number): TariffWindow {
  const field = `tariff[${index}]`;
  const record = asRecord(value, field);
  const start = parseTimestamp(record["start"], `${field}.start`);
  const end = parseTimestamp(record["end"], `${field}.end`);
  if (end <= start) {
    throw new ValidationError(`字段 ${field} 的结束时间必须晚于开始时间`);
  }
  return { start, end, pricePerKwh: asNumber(record["pricePerKwh"], `${field}.pricePerKwh`, { min: 0 }) };
}

export function parseSettings(value: unknown): Settings {
  if (value === undefined || value === null) {
    return { ...DEFAULT_SETTINGS };
  }
  const record = asRecord(value, "settings");
  const merged = { ...DEFAULT_SETTINGS };
  const minimums: Record<keyof Settings, number> = {
    slotMinutes: 1,
    meteringWindowMinutes: 1,
    ackTimeoutMinutes: 1,
    telemetryTimeoutMinutes: 1,
    horizonHours: 1,
    defaultPricePerKwh: 0,
    defaultLimitKw: 0,
  };
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
    if (record[key] !== undefined) {
      merged[key] = asNumber(record[key], `settings.${key}`, { min: minimums[key] });
    }
  }
  return merged;
}

export interface ParsedConfig {
  halls: HallConfig[];
  devices: DeviceConfig[];
  tariff: TariffWindow[];
  settings: Settings;
}

export function parseConfig(payload: unknown): ParsedConfig {
  const record = asRecord(payload, "config");
  const halls = asArray(record["halls"] ?? [], "halls").map(parseHall);
  const devices = asArray(record["devices"] ?? [], "devices").map(parseDevice);
  const tariff = asArray(record["tariff"] ?? [], "tariff").map(parseTariff);
  const settings = parseSettings(record["settings"]);

  const hallIds = new Set(halls.map((hall) => hall.id));
  if (hallIds.size !== halls.length) {
    throw new ValidationError("展厅标识重复");
  }
  const deviceIds = new Set(devices.map((device) => device.id));
  if (deviceIds.size !== devices.length) {
    throw new ValidationError("设备标识重复");
  }
  for (const device of devices) {
    if (!hallIds.has(device.hallId)) {
      throw new ValidationError(`设备 ${device.id} 属于未知展厅 ${device.hallId}`, "unknown_hall");
    }
  }
  dependencyOrder(devices); // 校验依赖存在且无环
  return { halls, devices, tariff, settings };
}

export function parseLimit(payload: unknown, seq: number): LimitWindow {
  const record = asRecord(payload, "limit");
  const start = parseTimestamp(record["start"], "start");
  const end = parseTimestamp(record["end"], "end");
  if (end <= start) {
    throw new ValidationError("限额窗口的结束时间必须晚于开始时间");
  }
  return {
    id: record["id"] === undefined ? `lim_${seq}` : asString(record["id"], "id"),
    start,
    end,
    maxKw: asNumber(record["maxKw"], "maxKw", { min: 0 }),
    reason: asString(record["reason"] ?? "园区削峰通知", "reason"),
  };
}

export function parseTelemetryBatch(payload: unknown): { deviceId: string; kw: number; at: number }[] {
  const record = asRecord(payload, "telemetry");
  return asArray(record["readings"], "readings").map((item, index) => {
    const reading = asRecord(item, `readings[${index}]`);
    return {
      deviceId: asString(reading["deviceId"], `readings[${index}].deviceId`),
      kw: asNumber(reading["kw"], `readings[${index}].kw`, { min: 0 }),
      at: parseTimestamp(reading["at"], `readings[${index}].at`),
    };
  });
}

export function parseReceipt(payload: unknown): { commandId: string; status: ReceiptStatus; detail: string | null } {
  const record = asRecord(payload, "receipt");
  return {
    commandId: asString(record["commandId"], "commandId"),
    status: asEnum(record["status"], "status", ["accepted", "completed", "rejected"] as const),
    detail: record["detail"] === undefined || record["detail"] === null ? null : asString(record["detail"], "detail"),
  };
}

const OVERRIDE_MODES: readonly OverrideMode[] = ["force_on", "force_off", "hold"];
export function parseOverride(payload: unknown, now: number): {
  deviceId: string;
  mode: OverrideMode;
  reason: string;
  createdBy: string;
  expiresAt: number;
} {
  const record = asRecord(payload, "override");
  let expiresAt: number | null = null;
  if (record["expiresAt"] !== undefined) {
    expiresAt = parseTimestamp(record["expiresAt"], "expiresAt");
  } else if (record["ttlMinutes"] !== undefined) {
    expiresAt = now + asNumber(record["ttlMinutes"], "ttlMinutes", { min: 1 }) * 60_000;
  }
  if (expiresAt === null) {
    throw new ValidationError("手动接管必须提供 expiresAt 或 ttlMinutes 作为有效期", "override_expiry_required");
  }
  return {
    deviceId: asString(record["deviceId"], "deviceId"),
    mode: asEnum(record["mode"], "mode", OVERRIDE_MODES),
    reason: asString(record["reason"] ?? "人工接管", "reason"),
    createdBy: asString(record["createdBy"] ?? "unknown", "createdBy"),
    expiresAt,
  };
}
