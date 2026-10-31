import { test } from "node:test";
import assert from "node:assert/strict";
import { FRESH_SECONDS, keyAllowed, latestEntry, liveBuses, parseBatch } from "../lib/positions.js";

const now = Date.parse("2026-10-31T08:15:30Z");
const body = (overrides = {}) => ({
  vehicle: "12",
  trip: "6f1c0e4e",
  line: "04",
  direction: "out",
  points: [
    { t: "2026-10-31T08:15:02Z", lat: 40.5214, lng: 21.2618, accuracy: 8, speed: 5.2, bearing: 120 },
    { t: "2026-10-31T08:15:27Z", lat: 40.5220, lng: 21.2630, accuracy: 6, speed: 6.1, bearing: 118 },
    { t: "2026-10-31T08:15:12Z", lat: 40.5216, lng: 21.2622 },
  ],
  ended: false,
  ...overrides,
});

test("the newest point of a batch is what's stored", () => {
  const { batch } = parseBatch(body());
  const entry = latestEntry(batch, now);
  assert.equal(entry.lat, 40.5220);
  assert.equal(entry.bearing, 118);
  assert.equal(entry.t, "2026-10-31T08:15:27.000Z");
  assert.equal(entry.receivedAt, "2026-10-31T08:15:30.000Z");
});

test("the app's JSON can come as a string too", () => {
  assert.ok(parseBatch(JSON.stringify(body())).batch);
});

test("points held back with no signal, or from the future, aren't the bus's position", () => {
  const old = parseBatch(body({ points: [{ t: "2026-10-31T08:10:00Z", lat: 40.5, lng: 21.2 }] })).batch;
  assert.equal(latestEntry(old, now), null);
  const future = parseBatch(body({ points: [{ t: "2026-10-31T08:20:00Z", lat: 40.5, lng: 21.2 }] })).batch;
  assert.equal(latestEntry(future, now), null);
});

test("an ended trip or an empty batch stores nothing", () => {
  assert.equal(latestEntry(parseBatch(body({ ended: true })).batch, now), null);
  assert.equal(latestEntry(parseBatch(body({ points: [] })).batch, now), null);
});

test("bad batches are refused with a reason", () => {
  assert.match(parseBatch("{").error, /JSON/);
  assert.match(parseBatch(body({ vehicle: "" })).error, /vehicle/);
  assert.match(parseBatch(body({ points: [{ t: "yesterday", lat: 40, lng: 21 }] })).error, /t \(ISO time\)/);
  assert.match(parseBatch(body({ points: [{ t: "2026-10-31T08:15:02Z", lat: 400, lng: 21 }] })).error, /lat and lng/);
  assert.match(parseBatch(body({ ended: "yes" })).error, /ended/);
});

test("odd optional values are dropped, not refused", () => {
  const { batch } = parseBatch(body({ points: [{ t: "2026-10-31T08:15:27Z", lat: 40.5, lng: 21.2, speed: -3, bearing: "north" }] }));
  assert.equal(batch.points[0].speed, null);
  assert.equal(batch.points[0].bearing, null);
});

test("only fresh buses are shown, without their trip ids, and the rest are tidied away", () => {
  const fresh = { vehicle: "12", trip: "a", line: "04", direction: "out", lat: 1, lng: 2, accuracy: 5, receivedAt: new Date(now - 10_000).toISOString() };
  const other = { ...fresh, vehicle: "07", line: "01" };
  const gone = { ...fresh, vehicle: "3", receivedAt: new Date(now - (FRESH_SECONDS + 1) * 1000).toISOString() };
  const { buses, stale } = liveBuses({ 12: fresh, "07": other, 3: gone, broken: {} }, now);
  assert.deepEqual(buses.map((b) => b.vehicle), ["07", "12"]);
  assert.equal(buses[0].trip, undefined);
  assert.equal(buses[0].accuracy, undefined);
  assert.deepEqual(stale.sort(), ["3", "broken"]);
  assert.deepEqual(liveBuses(null, now), { buses: [], stale: [] });
});

test("device keys: one of the list, nothing else", () => {
  assert.ok(keyAllowed("Bearer abc", "xyz, abc"));
  assert.ok(!keyAllowed("Bearer ab", "abc"));
  assert.ok(!keyAllowed("Bearer abc", ""));
  assert.ok(!keyAllowed("Bearer abc", undefined));
  assert.ok(!keyAllowed(undefined, "abc"));
  assert.ok(!keyAllowed("abc", "abc"));
});
