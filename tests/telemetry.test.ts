import assert from "node:assert/strict";
import { test } from "node:test";

import {
  classifyReading,
  latestReading,
  makeStoredReading,
  meteringWindowStart,
  windowAggregate,
} from "../src/domain/telemetry.js";
import { MIN, T0 } from "./helpers.js";

const WINDOW = 15;

test("迟到读数按事件时间归入正确计量窗口", () => {
  // 读数产生于 09:04（属于 09:00–09:15 窗口），却在 10:00 才到达。
  const eventAt = T0 + 4 * MIN;
  const arrivedAt = T0 + 60 * MIN;
  const stored = makeStoredReading({ deviceId: "d1", kw: 42, at: eventAt }, arrivedAt, WINDOW);
  assert.equal(stored.quality, "late");
  assert.equal(meteringWindowStart(eventAt, WINDOW), T0);

  const readings = [stored];
  // 事件所属窗口能查到该读数。
  const own = windowAggregate(readings, "d1", T0, WINDOW);
  assert.equal(own?.avgKw, 42);
  assert.equal(own?.qualities.late, 1);
  // 到达时刻所属窗口（09:15 之后已关闭的窗口不算）不受影响。
  const arrivalWindow = windowAggregate(readings, "d1", T0 + 60 * MIN, WINDOW);
  assert.equal(arrivalWindow, null);
});

test("窗口关闭前到达的读数质量为 good", () => {
  const stored = makeStoredReading({ deviceId: "d1", kw: 10, at: T0 + 2 * MIN }, T0 + 3 * MIN, WINDOW);
  assert.equal(stored.quality, "good");
});

test("非法读数标记 invalid 且不参与聚合", () => {
  const invalid = makeStoredReading({ deviceId: "d1", kw: -5, at: T0 + 1 * MIN }, T0 + 1 * MIN, WINDOW);
  assert.equal(invalid.quality, "invalid");
  const good = makeStoredReading({ deviceId: "d1", kw: 20, at: T0 + 2 * MIN }, T0 + 2 * MIN, WINDOW);
  const aggregate = windowAggregate([invalid, good], "d1", T0, WINDOW);
  assert.equal(aggregate?.avgKw, 20);
  assert.equal(aggregate?.samples, 1);
  assert.equal(aggregate?.qualities.invalid, 1);
  assert.equal(classifyReading({ deviceId: "d1", kw: Number.NaN, at: T0 }, T0, WINDOW), "invalid");
});

test("latestReading 取事件时间最新的有效读数", () => {
  const readings = [
    makeStoredReading({ deviceId: "d1", kw: 10, at: T0 + 1 * MIN }, T0 + 1 * MIN, WINDOW),
    makeStoredReading({ deviceId: "d1", kw: 30, at: T0 + 5 * MIN }, T0 + 5 * MIN, WINDOW),
    makeStoredReading({ deviceId: "d1", kw: -1, at: T0 + 9 * MIN }, T0 + 9 * MIN, WINDOW),
  ];
  assert.equal(latestReading(readings, "d1")?.kw, 30);
});
