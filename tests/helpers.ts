import { Orchestrator, type Clock } from "../src/domain/orchestrator.js";
import type { DeviceConfig, HallConfig, Settings } from "../src/domain/types.js";
import { MemoryJournal } from "../src/store/journal.js";

export class FakeClock implements Clock {
  constructor(public t: number) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

export const MIN = 60_000;
export const HOUR = 3_600_000;
/** 2026-09-17 09:00 +08:00 开馆时刻。 */
export const T0 = Date.parse("2026-09-17T09:00:00+08:00");
/** 2026-09-17 17:00 +08:00 闭馆时刻。 */
export const T_CLOSE = Date.parse("2026-09-17T17:00:00+08:00");

export function testSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    slotMinutes: 5,
    meteringWindowMinutes: 15,
    ackTimeoutMinutes: 2,
    telemetryTimeoutMinutes: 3,
    horizonHours: 12,
    defaultPricePerKwh: 0.5,
    defaultLimitKw: 1000,
    ...overrides,
  };
}

export function makeHall(overrides: Partial<HallConfig> & { id: string }): HallConfig {
  return {
    name: overrides.id,
    priority: 10,
    openWindows: [{ start: T0, end: T_CLOSE }],
    ...overrides,
  };
}

export function makeDevice(overrides: Partial<DeviceConfig> & { id: string }): DeviceConfig {
  return {
    hallId: "hall-a",
    name: overrides.id,
    loadClass: "deferrable",
    ratedPowerKw: 10,
    curve: [],
    runMinutes: 60,
    minRunMinutes: 0,
    shutdownMinutes: 0,
    requires: [],
    reducibleToKw: null,
    continuous: false,
    ...overrides,
  };
}

export function makeOrchestrator(
  clock: FakeClock,
  journal: MemoryJournal = new MemoryJournal(),
): { orchestrator: Orchestrator; journal: MemoryJournal } {
  return { orchestrator: new Orchestrator({ clock, journal }), journal };
}
