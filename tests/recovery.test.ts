import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Orchestrator } from "../src/domain/orchestrator.js";
import { FileJournal, MemoryJournal } from "../src/store/journal.js";
import { FakeClock, HOUR, makeDevice, makeHall, MIN, T0, testSettings } from "./helpers.js";

function baseConfig() {
  return {
    halls: [makeHall({ id: "hall-a", priority: 10 })],
    devices: [
      makeDevice({ id: "safe", loadClass: "collection_protection", ratedPowerKw: 10, continuous: true }),
      makeDevice({ id: "flex", loadClass: "deferrable", ratedPowerKw: 40, runMinutes: 120 }),
    ],
    tariff: [],
    settings: testSettings(),
  };
}

test("进程恢复后重放日志，继续原计划的计时与补偿", () => {
  const clock = new FakeClock(T0);
  const journal = new MemoryJournal();
  const first = new Orchestrator({ clock, journal });
  first.loadConfig(baseConfig());
  // 手动接管触发补偿链：start 被 stop 补偿。
  first.setOverride({
    deviceId: "flex",
    mode: "force_off",
    reason: "检修",
    createdBy: "ops",
    expiresAt: T0 + 30 * MIN,
  });
  const commandsBefore = Object.keys(first.state.commands).sort();
  assert.ok(commandsBefore.length >= 2);

  // 模拟进程重启：新实例从日志重放，时钟继续前进。
  const recovered = Orchestrator.replay(journal.loadAll(), { clock, journal });
  assert.deepEqual(Object.keys(recovered.state.commands).sort(), commandsBefore);
  assert.equal(recovered.state.plan?.version, first.state.plan?.version);
  const stopCommand = recovered.state.commands[`cmd_flex_stop_${T0}`];
  assert.equal(stopCommand?.supersedes, `cmd_flex_start_${T0}`, "补偿链应在恢复后保留");

  // 恢复后继续原计划计时：接管到期自动解除，设备按下一时槽补偿恢复。
  clock.t = T0 + 31 * MIN;
  recovered.evaluate();
  clock.t = T0 + 35 * MIN;
  recovered.evaluate();
  assert.equal(recovered.effectiveState("flex").running, true, "恢复后应继续执行补偿恢复");
});

test("恢复后到期命令按原计划时刻下发，不重复、不漏发", () => {
  const clock = new FakeClock(T0);
  const journal = new MemoryJournal();
  const first = new Orchestrator({ clock, journal });
  first.loadConfig(baseConfig());
  const planAtBoot = first.state.plan;
  assert.ok(planAtBoot);

  // 进程“宕机”两小时：期间有计划命令到期。恢复后评估应立即补发，且命令标识与原计划一致。
  clock.t = T0 + 2 * HOUR;
  const recovered = Orchestrator.replay(journal.loadAll(), { clock, journal });
  recovered.evaluate();
  const stopId = `cmd_flex_stop_${T0 + 2 * HOUR}`;
  assert.ok(recovered.state.commands[stopId], "宕机期间到期的 stop 应在恢复后补发");
  assert.equal(recovered.state.commands[stopId]?.at, T0 + 2 * HOUR, "命令保持原计划时刻");
  assert.equal(Object.keys(recovered.state.commands).filter((id) => id === stopId).length, 1);

  // 再次评估不得重复下发。
  const count = Object.keys(recovered.state.commands).length;
  recovered.evaluate();
  assert.equal(Object.keys(recovered.state.commands).length, count);
});

test("文件日志持久化后可完整还原状态", () => {
  const dir = mkdtempSync(join(tmpdir(), "orchestrator-"));
  try {
    const clock = new FakeClock(T0);
    const journal = new FileJournal(dir);
    const first = new Orchestrator({ clock, journal });
    first.loadConfig(baseConfig());
    first.ingestTelemetry([{ deviceId: "flex", kw: 40, at: T0 }]);
    first.recordReceipt({ commandId: `cmd_flex_start_${T0}`, status: "accepted" });

    // 新进程：从磁盘重放。
    const reloaded = new FileJournal(dir);
    const events = reloaded.loadAll();
    assert.ok(events.length > 0);
    const recovered = Orchestrator.replay(events, { clock, journal: reloaded });
    assert.deepEqual(recovered.state, first.state, "重放后状态应与原进程一致");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
