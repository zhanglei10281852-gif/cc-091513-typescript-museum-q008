import assert from "node:assert/strict";
import { test } from "node:test";

import { plan, type PlanInput } from "../src/domain/planner.js";
import { HOUR, makeDevice, makeHall, T0, T_CLOSE, testSettings } from "./helpers.js";

function baseInput(overrides: Partial<PlanInput> = {}): PlanInput {
  return {
    now: T0,
    settings: testSettings(),
    halls: [makeHall({ id: "hall-a" })],
    devices: [],
    tariff: [],
    limits: [],
    overrides: [],
    assumed: new Map(),
    ...overrides,
  };
}

test("排程只在开放时段内生成动作", () => {
  const output = plan(
    baseInput({
      devices: [makeDevice({ id: "d1", runMinutes: 60 })],
    }),
  );
  assert.ok(output.entries.length >= 2);
  for (const entry of output.entries) {
    assert.ok(entry.at >= T0, `动作 ${entry.entryId} 早于开馆`);
    assert.ok(entry.at <= T_CLOSE, `动作 ${entry.entryId} 晚于闭馆`);
  }
  const start = output.entries.find((entry) => entry.action === "start");
  const stop = output.entries.find((entry) => entry.action === "stop");
  assert.equal(start?.at, T0);
  assert.equal(stop?.at, T0 + 60 * 60_000);
});

test("可延迟负荷选择电价低谷，访客关键负荷尽早启动", () => {
  const tariff = [
    { start: T0, end: T0 + 3 * HOUR, pricePerKwh: 1.5 },
    { start: T0 + 3 * HOUR, end: T_CLOSE, pricePerKwh: 0.3 },
  ];
  const output = plan(
    baseInput({
      tariff,
      devices: [
        makeDevice({ id: "flex", loadClass: "deferrable", runMinutes: 60 }),
        makeDevice({ id: "show", loadClass: "visitor_critical", runMinutes: 60 }),
      ],
    }),
  );
  const flexStart = output.entries.find((entry) => entry.deviceId === "flex" && entry.action === "start");
  const showStart = output.entries.find((entry) => entry.deviceId === "show" && entry.action === "start");
  assert.equal(flexStart?.at, T0 + 3 * HOUR, "可延迟负荷应等到电价低谷");
  assert.match(flexStart?.reason ?? "", /电价/);
  assert.equal(showStart?.at, T0, "访客关键负荷应在开放时段开始时启动");
});

test("启停依赖：被依赖设备先启动、留足顺序关机时长后停机", () => {
  const output = plan(
    baseInput({
      devices: [
        makeDevice({ id: "dep", loadClass: "visitor_critical", runMinutes: 30 }),
        makeDevice({ id: "main", loadClass: "visitor_critical", runMinutes: 60, shutdownMinutes: 15, requires: ["dep"] }),
      ],
    }),
  );
  const depStart = output.entries.find((entry) => entry.deviceId === "dep" && entry.action === "start");
  const depStop = output.entries.find((entry) => entry.deviceId === "dep" && entry.action === "stop");
  const mainStart = output.entries.find((entry) => entry.deviceId === "main" && entry.action === "start");
  const mainStop = output.entries.find((entry) => entry.deviceId === "main" && entry.action === "stop");
  assert.ok(depStart && mainStart && depStop && mainStop);
  assert.ok(depStart.at <= mainStart.at, "被依赖设备不得晚于依赖方启动");
  assert.equal(mainStop.at, T0 + 60 * 60_000);
  assert.equal(depStop.at, mainStop.at + 15 * 60_000, "被依赖设备需等依赖方顺序关机完成后停机");
  assert.match(depStop.reason, /顺序关机/);
});

test("限额削减只针对非关键负荷：先降载、再延迟、最后关停", () => {
  const output = plan(
    baseInput({
      settings: testSettings({ defaultLimitKw: 60 }),
      halls: [makeHall({ id: "hall-a", priority: 10 }), makeHall({ id: "hall-b", priority: 20 })],
      devices: [
        makeDevice({ id: "safe", loadClass: "collection_protection", ratedPowerKw: 20, continuous: true }),
        makeDevice({ id: "show", loadClass: "visitor_critical", ratedPowerKw: 25, runMinutes: 480 }),
        makeDevice({ id: "dimmable", hallId: "hall-b", ratedPowerKw: 20, reducibleToKw: 10, runMinutes: 480 }),
        makeDevice({ id: "extra", hallId: "hall-b", ratedPowerKw: 15, runMinutes: 60 }),
      ],
    }),
  );
  // 保护类与访客关键负荷绝不被削减：没有针对它们的 reduce/提前 stop。
  assert.equal(output.entries.filter((entry) => entry.deviceId === "safe").length, 0);
  assert.equal(output.entries.filter((entry) => entry.deviceId === "show" && entry.action === "reduce").length, 0);
  const showStop = output.entries.find((entry) => entry.deviceId === "show" && entry.action === "stop");
  assert.equal(showStop?.at, T0 + 480 * 60_000, "访客关键负荷应完整运行会话");
  // 可延迟负荷：dimmable 被降载，extra 被关停或延迟。
  const reduce = output.entries.find((entry) => entry.deviceId === "dimmable" && entry.action === "reduce");
  assert.ok(reduce, "应优先降载可降载设备");
  assert.equal(reduce.targetKw, 10);
  assert.match(reduce.reason, /降载/);
  const extraStop = output.entries.find((entry) => entry.deviceId === "extra" && entry.action === "stop");
  assert.ok(extraStop);
  assert.match(extraStop.reason, /削峰|延迟/);
  // 预测负荷不超过限额。
  for (const point of output.forecast) {
    assert.ok(point.kw <= 60 + 1e-9, `时段 ${point.at} 预测 ${point.kw}kW 超出限额`);
  }
});

test("限额不可行时保护类负荷仍不被削减并给出告警", () => {
  const output = plan(
    baseInput({
      settings: testSettings({ defaultLimitKw: 15 }),
      devices: [
        makeDevice({ id: "safe", loadClass: "life_safety", ratedPowerKw: 20, continuous: true }),
        makeDevice({ id: "flex", ratedPowerKw: 10, runMinutes: 60 }),
      ],
    }),
  );
  assert.equal(output.entries.filter((entry) => entry.deviceId === "safe").length, 0);
  assert.ok(output.warnings.some((warning) => warning.includes("超出限额")));
});

test("相同输入产生完全相同的计划（确定性）", () => {
  const input = baseInput({
    settings: testSettings({ defaultLimitKw: 50 }),
    halls: [makeHall({ id: "hall-a", priority: 10 }), makeHall({ id: "hall-b", priority: 20 })],
    devices: [
      makeDevice({ id: "a", hallId: "hall-a", ratedPowerKw: 30, runMinutes: 120 }),
      makeDevice({ id: "b", hallId: "hall-b", ratedPowerKw: 30, runMinutes: 120 }),
      makeDevice({ id: "c", hallId: "hall-b", ratedPowerKw: 15, runMinutes: 90 }),
    ],
  });
  const first = plan(input);
  const second = plan(input);
  assert.deepEqual(second, first);
});

test("展厅额度按批准优先级稳定分配", () => {
  const output = plan(
    baseInput({
      settings: testSettings({ defaultLimitKw: 40 }),
      halls: [makeHall({ id: "hall-a", priority: 10 }), makeHall({ id: "hall-b", priority: 20 })],
      devices: [
        makeDevice({ id: "a", hallId: "hall-a", loadClass: "visitor_critical", ratedPowerKw: 30, runMinutes: 480 }),
        makeDevice({ id: "b", hallId: "hall-b", loadClass: "visitor_critical", ratedPowerKw: 30, runMinutes: 480 }),
      ],
    }),
  );
  const allocA = output.allocations.find((alloc) => alloc.hallId === "hall-a");
  const allocB = output.allocations.find((alloc) => alloc.hallId === "hall-b");
  assert.ok(allocA && allocB);
  assert.equal(allocA.allocatedKw, 30, "高优先级展厅应获得全额");
  assert.ok(allocB.allocatedKw <= 10.001, "低优先级展厅仅获得剩余额度");
});
