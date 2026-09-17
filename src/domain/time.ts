export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;

export function floorTo(ms: number, sizeMs: number): number {
  return Math.floor(ms / sizeMs) * sizeMs;
}

export function ceilTo(ms: number, sizeMs: number): number {
  return Math.ceil(ms / sizeMs) * sizeMs;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 解析 ISO 时间字符串或 epoch 毫秒数为 epoch 毫秒。 */
export function parseTimestamp(value: unknown, field: string): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.round(value);
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  throw new ValidationError(`字段 ${field} 不是合法时间（ISO 字符串或 epoch 毫秒）`);
}

export class ValidationError extends Error {
  readonly code: string;
  constructor(message: string, code = "invalid_request") {
    super(message);
    this.name = "ValidationError";
    this.code = code;
  }
}
