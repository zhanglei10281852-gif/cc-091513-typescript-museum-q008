import { floorTo, MINUTE_MS } from "./time.js";
import type { StoredReading, TelemetryQuality } from "./types.js";

/**
 * 遥测计量：读数按事件时间归入固定计量窗口，与到达时间无关。
 * 因此迟到读数会修正其本应所属的历史窗口，而不是落入到达时的窗口。
 */

export interface IngestResult {
  quality: TelemetryQuality;
  windowStart: number;
}

export function meteringWindowStart(at: number, windowMinutes: number): number {
  return floorTo(at, windowMinutes * MINUTE_MS);
}

/** 判定读数质量：非法值 → invalid；窗口已关闭且超过宽限 → late；否则 good。 */
export function classifyReading(
  reading: { deviceId: string; kw: number; at: number },
  receivedAt: number,
  windowMinutes: number,
): TelemetryQuality {
  if (!Number.isFinite(reading.kw) || reading.kw < 0 || !Number.isFinite(reading.at)) {
    return "invalid";
  }
  const windowEnd = meteringWindowStart(reading.at, windowMinutes) + windowMinutes * MINUTE_MS;
  const graceMs = windowMinutes * MINUTE_MS;
  if (receivedAt > windowEnd + graceMs) {
    return "late";
  }
  return "good";
}

export function makeStoredReading(
  reading: { deviceId: string; kw: number; at: number },
  receivedAt: number,
  windowMinutes: number,
): StoredReading {
  return {
    deviceId: reading.deviceId,
    kw: reading.kw,
    at: reading.at,
    receivedAt,
    quality: classifyReading(reading, receivedAt, windowMinutes),
  };
}

/** 窗口聚合：仅统计有效读数（good/late），返回平均功率；无有效读数返回 null。 */
export function windowAggregate(
  readings: StoredReading[],
  deviceId: string,
  windowStart: number,
  windowMinutes: number,
): { avgKw: number; samples: number; qualities: Record<TelemetryQuality, number> } | null {
  const windowEnd = windowStart + windowMinutes * MINUTE_MS;
  const qualities: Record<TelemetryQuality, number> = { good: 0, late: 0, missing: 0, invalid: 0 };
  let sum = 0;
  let samples = 0;
  for (const reading of readings) {
    if (reading.deviceId !== deviceId || reading.at < windowStart || reading.at >= windowEnd) {
      continue;
    }
    qualities[reading.quality] += 1;
    if (reading.quality === "good" || reading.quality === "late") {
      sum += reading.kw;
      samples += 1;
    }
  }
  if (samples === 0 && qualities.invalid === 0) {
    return null;
  }
  return { avgKw: samples > 0 ? Math.round((sum / samples) * 1000) / 1000 : 0, samples, qualities };
}

/** 设备最新一条有效读数。 */
export function latestReading(readings: StoredReading[], deviceId: string): StoredReading | null {
  let latest: StoredReading | null = null;
  for (const reading of readings) {
    if (reading.deviceId !== deviceId || reading.quality === "invalid") {
      continue;
    }
    if (!latest || reading.at > latest.at) {
      latest = reading;
    }
  }
  return latest;
}
