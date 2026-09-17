import assert from "node:assert/strict";
import { test } from "node:test";

import { Orchestrator } from "../src/domain/orchestrator.js";
import { ValidationError } from "../src/domain/time.js";
import { MemoryJournal } from "../src/store/journal.js";
import { FakeClock, HOUR, makeDevice, makeHall, MIN, T0, T_CLOSE, testSettings } from "./helpers.js";

function baseConfig() {
  return {
    halls: [makeHall({ id: "hall-a", priority: 10 }), makeHall({ id: "hall-b", priority: 20 })],
    devices: [
      makeDevice({ id: "safe", hallId: "hall-a", loadClass: "life_safety", ratedPowerKw: 10, continuous: true }),
      makeDevice({ id: "show", hallId: "hall-a", loadClass: "visitor_critical", ratedPowerKw: 30, runMinutes: 480 }),
      makeDevice({ id: "flex", hallId: "hall-b", loadClass: "deferrable", ratedPowerKw: 40, runMinutes: 120 }),
    ],
    tariff: [],
    settings: testSettings(),
  };
}

function boot(at: number = T0): { orchestrator: Orchestrator; clock: FakeClock; journal: MemoryJournal } {
  const clock = new FakeClock(at);
  const journal = new MemoryJournal();
  const orchestrator = new Orchestrator({ clock, journal });
  orchestrator.loadConfig(baseConfig());
  return { orchestrator, clock, journal };
}

test("限额变化立即重排非关键负荷，保护类与访客关键负荷不受影响", () => {
  const { orchestrator } = boot();
  assert.equal(orchestrator.state.planVersion, 1);

  orchestrator.setLimit({ id: "lim-1", start: T0, end: T0 + 2 * HOUR, maxKw: 45, reason: "园区临时削峰" });
  const plan = orchestrator.state.plan;
  assert.ok(plan && plan.version >= 2, "削峰通知应触发新计划版本");

  // flex（可延迟 40kW）被延迟到限额窗口之后；show（访客关键）与 safe（保护类）保持。
  const flexStart = plan.entries.find((entry) => entry.deviceId === "flex" && entry.action === "start");
  assert.equal(flexStart?.at, T0 + 2 * HOUR);
  assert.match(flexStart?.reason ?? "", /削峰|延迟/);
  const showStart = plan.entries.find((entry) => entry.deviceId === "show" && entry.action === "start");
  assert.equal(showStart?.at, T0);
  assert.equal(plan.entries.filter((entry) => entry.deviceId === "safe").length, 0);

  // 主管能看到延迟原因。
  const reasons = orchestrator.state.decisions.map((decision) => decision.reason).join("\n");
  assert.match(reasons, /削峰/);
});

test("已下发命令只能通过补偿动作撤销，原命令保留且不可变", () => {
  const { orchestrator } = boot();
  const startId = `cmd_flex_start_${T0}`;
  const original = orchestrator.state.commands[startId];
  assert.ok(original, "开馆时应已下发 flex 启动命令");

  // 手动接管强制关停 → 补偿 stop 撤销已下发的 start。
  orchestrator.setOverride({
    deviceId: "flex",
    mode: "force_off",
    reason: "展项检修",
    createdBy: "ops",
    expiresAt: T0 + 30 * MIN,
  });
  const stopId = `cmd_flex_stop_${T0}`;
  const compensation = orchestrator.state.commands[stopId];
  assert.ok(compensation, "应下发补偿 stop 命令");
  assert.equal(compensation.supersedes, startId);
  assert.equal(orchestrator.state.commands[startId]?.compensatedBy, stopId);
  assert.equal(orchestrator.state.commands[startId]?.action, "start", "原命令内容不得修改");
  assert.equal(orchestrator.effectiveState("flex").running, false);
});

test("手动接管到期自动失效并恢复自动编排", () => {
  const { orchestrator, clock } = boot();
  orchestrator.setOverride({
    deviceId: "flex",
    mode: "force_off",
    reason: "展项检修",
    createdBy: "ops",
    expiresAt: T0 + 30 * MIN,
  });
  assert.equal(orchestrator.effectiveState("flex").running, false);

  clock.t = T0 + 31 * MIN;
  orchestrator.evaluate();
  const override = Object.values(orchestrator.state.overrides)[0];
  assert.ok(override && override.releasedAt !== null, "到期接管应被解除");

  // 恢复编排：flex 在下一时槽重新启动（补偿此前的 stop）。
  clock.t = T0 + 35 * MIN;
  orchestrator.evaluate();
  assert.equal(orchestrator.effectiveState("flex").running, true);
  const restart = orchestrator.state.commands[`cmd_flex_start_${T0 + 35 * MIN}`];
  assert.ok(restart, "接管到期后应补偿恢复启动");
  assert.equal(restart.supersedes, `cmd_flex_stop_${T0}`);
});

test("手动接管必须有有效期，且不得关停保护类设备", () => {
  const { orchestrator } = boot();
  assert.throws(
    () =>
      orchestrator.setOverride({
        deviceId: "flex",
        mode: "force_off",
        reason: "x",
        createdBy: "ops",
        expiresAt: T0 - 1,
      }),
    (error: unknown) => error instanceof ValidationError && error.code === "override_expiry_required",
  );
  assert.throws(
    () =>
      orchestrator.setOverride({
        deviceId: "safe",
        mode: "force_off",
        reason: "x",
        createdBy: "ops",
        expiresAt: T0 + 10 * MIN,
      }),
    (error: unknown) => error instanceof ValidationError && error.code === "protected_device",
  );
});

test("设备回执按命令标识去重", () => {
  const { orchestrator } = boot();
  const commandId = `cmd_flex_start_${T0}`;
  const first = orchestrator.recordReceipt({ commandId, status: "accepted" });
  assert.equal(first.deduplicated, false);
  const second = orchestrator.recordReceipt({ commandId, status: "completed", detail: "重复回执" });
  assert.equal(second.deduplicated, true);
  assert.equal(second.receipt.status, "accepted", "重复回执不得覆盖首次记录");
  assert.equal(Object.keys(orchestrator.state.receipts).length, 1);
});

test("命令超时未回执的设备标记为未响应，回执后恢复", () => {
  const { orchestrator, clock } = boot();
  clock.t = T0 + 3 * MIN;
  orchestrator.evaluate();
  const status = orchestrator.status() as { unresponsiveDevices: { deviceId: string; commandId: string }[] };
  assert.ok(
    status.unresponsiveDevices.some((device) => device.deviceId === "flex"),
    "超时未回执应标记未响应",
  );
  orchestrator.recordReceipt({ commandId: `cmd_flex_start_${T0}`, status: "accepted" });
  const after = orchestrator.status() as { unresponsiveDevices: { deviceId: string }[] };
  assert.ok(!after.unresponsiveDevices.some((device) => device.deviceId === "flex"), "回执后应解除未响应");
  assert.ok(after.unresponsiveDevices.some((device) => device.deviceId === "show"), "其他设备仍保持未响应");
});

test("遥测缺失触发保守重排，恢复后解除", () => {
  const { orchestrator, clock } = boot();
  orchestrator.ingestTelemetry([{ deviceId: "flex", kw: 38, at: T0 }]);
  clock.t = T0 + 10 * MIN;
  orchestrator.evaluate();
  const status = orchestrator.status() as {
    missingTelemetry: { deviceId: string }[];
    assumedDevices: string[];
  };
  assert.ok(status.missingTelemetry.some((device) => device.deviceId === "flex"));
  assert.ok(status.assumedDevices.includes("flex"), "缺失遥测的设备应按假定负荷估计");

  orchestrator.ingestTelemetry([{ deviceId: "flex", kw: 36, at: clock.t }]);
  const after = orchestrator.status() as { missingTelemetry: { deviceId: string }[] };
  assert.ok(!after.missingTelemetry.some((device) => device.deviceId === "flex"), "遥测恢复后应解除缺失标记");
});

test("主管视图包含当前负荷、未来峰值、原因与未响应设备", () => {
  const { orchestrator } = boot();
  orchestrator.setLimit({ id: "lim-1", start: T0, end: T0 + 2 * HOUR, maxKw: 45, reason: "削峰" });
  const status = orchestrator.status() as {
    currentLoadKw: number;
    limitKw: number;
    forecastPeak: { at: number; kw: number } | null;
    recentDecisions: { reason: string }[];
    unresponsiveDevices: unknown[];
    plan: { upcomingEntries: unknown[]; allocations: unknown[] };
  };
  assert.equal(status.limitKw, 45);
  assert.ok(status.currentLoadKw >= 0);
  assert.ok(status.forecastPeak !== null && status.forecastPeak.kw > 0);
  assert.ok(status.recentDecisions.length > 0);
  assert.ok(status.plan.upcomingEntries.length > 0);
  assert.ok(status.plan.allocations.length > 0);
});

test("遥测读数决定当前负荷，缺失时按命令状态保守估计", () => {
  const { orchestrator } = boot();
  orchestrator.ingestTelemetry([
    { deviceId: "flex", kw: 41, at: T0 },
    { deviceId: "show", kw: 29, at: T0 },
  ]);
  const status = orchestrator.status() as { currentLoadKw: number };
  // safe 连续运行 10kW（假定）+ flex 41 + show 29
  assert.equal(status.currentLoadKw, 80);
});
