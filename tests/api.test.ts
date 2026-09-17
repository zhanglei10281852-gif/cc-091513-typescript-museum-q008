import assert from "node:assert/strict";
import { test } from "node:test";
import type { AddressInfo } from "node:net";

import { createApp } from "../src/app.js";
import { Orchestrator } from "../src/domain/orchestrator.js";
import { MemoryJournal } from "../src/store/journal.js";
import { FakeClock, makeDevice, makeHall, MIN, T0, testSettings } from "./helpers.js";

interface TestServer {
  base: string;
  close: () => Promise<void>;
}

async function startServer(): Promise<{ server: TestServer; orchestrator: Orchestrator; clock: FakeClock }> {
  const clock = new FakeClock(T0);
  const orchestrator = new Orchestrator({ clock, journal: new MemoryJournal() });
  const app = createApp({ orchestrator });
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  const port = (app.address() as AddressInfo).port;
  return {
    orchestrator,
    clock,
    server: {
      base: `http://127.0.0.1:${port}`,
      close: () =>
        new Promise<void>((resolve, reject) => app.close((error) => (error ? reject(error) : resolve()))),
    },
  };
}

const CONFIG_BODY = {
  halls: [{ id: "hall-a", name: "展厅 A", priority: 10, openWindows: [{ start: T0, end: T0 + 8 * 3_600_000 }] }],
  devices: [
    { id: "safe", hallId: "hall-a", name: "恒温展示柜", loadClass: "collection_protection", ratedPowerKw: 10, continuous: true },
    { id: "flex", hallId: "hall-a", name: "机械展项", loadClass: "deferrable", ratedPowerKw: 40, runMinutes: 120 },
  ],
  tariff: [],
  settings: testSettings(),
};

async function post(base: string, path: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

test("HTTP 端到端：配置、限额、遥测、回执、接管与状态视图", async () => {
  const { server } = await startServer();
  try {
    // 加载配置
    const config = await post(server.base, "/v1/config", CONFIG_BODY);
    assert.equal(config.status, 201);

    // 削峰通知 → 触发重排
    const limit = await post(server.base, "/v1/limits", {
      start: T0,
      end: T0 + 2 * 3_600_000,
      maxKw: 30,
      reason: "园区临时削峰",
    });
    assert.equal(limit.status, 201);

    const planResponse = await fetch(`${server.base}/v1/plan`);
    const plan = (await planResponse.json()) as { version: number; entries: { deviceId: string; reason: string }[] };
    assert.ok(plan.version >= 2);
    const flexEntry = plan.entries.find((entry) => entry.deviceId === "flex");
    assert.ok(flexEntry, "计划中应包含 flex 的动作");

    // 遥测上报
    const telemetry = await post(server.base, "/v1/telemetry", {
      readings: [{ deviceId: "flex", kw: 38, at: T0 }],
    });
    assert.equal(telemetry.status, 201);
    assert.equal((telemetry.json as { results: { quality: string }[] }).results[0]?.quality, "good");

    // 回执去重：同一命令标识重复上报
    const commandId = `cmd_flex_start_${T0}`;
    const receipt1 = await post(server.base, "/v1/receipts", { commandId, status: "accepted" });
    assert.equal(receipt1.status, 201);
    const receipt2 = await post(server.base, "/v1/receipts", { commandId, status: "completed" });
    assert.equal(receipt2.status, 200);
    assert.equal((receipt2.json as { deduplicated: boolean }).deduplicated, true);

    // 未知命令回执 → 404
    const unknown = await post(server.base, "/v1/receipts", { commandId: "cmd_none", status: "accepted" });
    assert.equal(unknown.status, 404);

    // 手动接管：保护类设备强制关停 → 409；缺少有效期 → 400
    const protectedOverride = await post(server.base, "/v1/overrides", {
      deviceId: "safe",
      mode: "force_off",
      reason: "测试",
      createdBy: "ops",
      ttlMinutes: 30,
    });
    assert.equal(protectedOverride.status, 409);
    const noExpiry = await post(server.base, "/v1/overrides", {
      deviceId: "flex",
      mode: "hold",
      reason: "测试",
      createdBy: "ops",
    });
    assert.equal(noExpiry.status, 400);

    // 正常接管 → 201，且能在状态中看到
    const override = await post(server.base, "/v1/overrides", {
      deviceId: "flex",
      mode: "hold",
      reason: "现场调试",
      createdBy: "ops",
      expiresAt: T0 + 30 * MIN,
    });
    assert.equal(override.status, 201);

    // 主管状态视图
    const statusResponse = await fetch(`${server.base}/v1/status`);
    const status = (await statusResponse.json()) as {
      currentLoadKw: number;
      forecastPeak: { kw: number } | null;
      activeOverrides: unknown[];
      recentDecisions: unknown[];
    };
    assert.ok(status.currentLoadKw >= 0);
    assert.ok(status.forecastPeak !== null);
    assert.equal(status.activeOverrides.length, 1);
    assert.ok(status.recentDecisions.length > 0);

    // 计量视图：迟到读数归入事件时间窗口
    const metering = await fetch(`${server.base}/v1/metering?from=${T0}&to=${T0 + 3_600_000}`);
    assert.equal(metering.status, 200);
    const rows = (await metering.json()) as { deviceId: string; avgKw: number }[];
    assert.ok(rows.some((row) => row.deviceId === "flex" && row.avgKw === 38));

    // 命令台账
    const commands = await fetch(`${server.base}/v1/commands`);
    assert.equal(commands.status, 200);
    assert.ok(((await commands.json()) as unknown[]).length > 0);
  } finally {
    await server.close();
  }
});

test("配置校验：未知依赖与非法负荷等级返回 400", async () => {
  const { server } = await startServer();
  try {
    const badDependency = await post(server.base, "/v1/config", {
      ...CONFIG_BODY,
      devices: [
        { id: "d1", hallId: "hall-a", name: "x", loadClass: "deferrable", ratedPowerKw: 10, requires: ["ghost"] },
      ],
    });
    assert.equal(badDependency.status, 400);

    const badClass = await post(server.base, "/v1/config", {
      ...CONFIG_BODY,
      devices: [{ id: "d1", hallId: "hall-a", name: "x", loadClass: "unknown", ratedPowerKw: 10 }],
    });
    assert.equal(badClass.status, 400);
  } finally {
    await server.close();
  }
});
