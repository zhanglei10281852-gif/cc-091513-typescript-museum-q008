import assert from "node:assert/strict";
import { test } from "node:test";

import { allocateStable } from "../src/domain/allocation.js";

test("高优先级展厅先获得全额，剩余分给低优先级", () => {
  const grants = allocateStable(
    [
      { hallId: "hall-b", priority: 20, demandedKw: 100 },
      { hallId: "hall-a", priority: 10, demandedKw: 100 },
    ],
    150,
  );
  assert.equal(grants.find((grant) => grant.hallId === "hall-a")?.allocatedKw, 100);
  assert.equal(grants.find((grant) => grant.hallId === "hall-b")?.allocatedKw, 50);
});

test("同优先级按需求比例分配", () => {
  const grants = allocateStable(
    [
      { hallId: "hall-a", priority: 10, demandedKw: 60 },
      { hallId: "hall-b", priority: 10, demandedKw: 30 },
    ],
    60,
  );
  assert.equal(grants.find((grant) => grant.hallId === "hall-a")?.allocatedKw, 40);
  assert.equal(grants.find((grant) => grant.hallId === "hall-b")?.allocatedKw, 20);
});

test("容量为零时所有展厅额度为零", () => {
  const grants = allocateStable([{ hallId: "hall-a", priority: 10, demandedKw: 50 }], 0);
  assert.equal(grants[0]?.allocatedKw, 0);
});

test("分配结果稳定：相同输入多次计算完全一致", () => {
  const requests = [
    { hallId: "hall-c", priority: 10, demandedKw: 33.7 },
    { hallId: "hall-a", priority: 10, demandedKw: 21.2 },
    { hallId: "hall-b", priority: 20, demandedKw: 48.9 },
  ];
  const first = allocateStable(requests, 60);
  for (let index = 0; index < 20; index += 1) {
    assert.deepEqual(allocateStable(requests, 60), first);
  }
  const total = first.reduce((sum, grant) => sum + grant.allocatedKw, 0);
  assert.ok(Math.abs(total - 60) < 0.01, "分配总额应等于可用容量");
});

test("需求为零的展厅不占用额度", () => {
  const grants = allocateStable(
    [
      { hallId: "hall-a", priority: 10, demandedKw: 0 },
      { hallId: "hall-b", priority: 20, demandedKw: 50 },
    ],
    80,
  );
  assert.equal(grants.find((grant) => grant.hallId === "hall-a")?.allocatedKw, 0);
  assert.equal(grants.find((grant) => grant.hallId === "hall-b")?.allocatedKw, 50);
});
