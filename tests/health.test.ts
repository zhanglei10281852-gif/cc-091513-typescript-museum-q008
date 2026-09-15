import assert from "node:assert/strict";
import { test } from "node:test";

import { createApp, healthPayload } from "../src/app.js";

test("健康信息包含服务名称", () => {
  assert.deepEqual(healthPayload(), {
    status: "ok",
    service: "展项能源负荷编排服务",
  });
});

test("健康接口返回 JSON", async () => {
  const server = createApp();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const response = await fetch(`http://127.0.0.1:${address.port}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), healthPayload());
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
