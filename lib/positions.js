// What the server does with positions, apart from Redis: checking what a phone
// sent, keeping the latest position of each bus, and which buses are on the road.
// Pure functions, so `npm test` can check them without a database.

import { timingSafeEqual } from "node:crypto";

/** One Redis hash, field = vehicle, value = its latest position */
export const LIVE_KEY = "astiko-ktel:live";

/** A bus not heard from for this long is no longer shown */
export const FRESH_SECONDS = 120;

/** A position this old when it arrives was held back with no signal: history, not where the bus is */
export const MAX_POINT_AGE_SECONDS = 180;

/** At most this many points in one batch; the app sends up to 200 */
export const MAX_POINTS = 500;

const text = (value, max) => typeof value === "string" && value.length > 0 && value.length <= max;
const number = (value, min, max) => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;

/**
 * Checks a batch from a phone (see the README for its shape). Returns `{ batch }` with only the
 * fields the server uses, or `{ error }` saying what's wrong.
 */
export function parseBatch(body) {
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return { error: "Body is not JSON" };
    }
  }
  if (!body || typeof body !== "object") return { error: "Body is not an object" };
  const { vehicle, trip, line, direction, points = [], ended = false } = body;
  if (!text(vehicle, 32)) return { error: "vehicle must be a string of up to 32 characters" };
  if (!text(trip, 64)) return { error: "trip must be a string of up to 64 characters" };
  if (typeof line !== "string" || line.length > 8) return { error: "line must be a string" };
  if (typeof direction !== "string" || direction.length > 8) return { error: "direction must be a string" };
  if (!Array.isArray(points) || points.length > MAX_POINTS) return { error: `points must be a list of up to ${MAX_POINTS}` };
  if (typeof ended !== "boolean") return { error: "ended must be true or false" };

  const clean = [];
  for (const p of points) {
    const time = Date.parse(p?.t);
    if (!Number.isFinite(time) || !number(p.lat, -90, 90) || !number(p.lng, -180, 180)) {
      return { error: "every point needs t (ISO time), lat and lng" };
    }
    clean.push({
      time,
      lat: p.lat,
      lng: p.lng,
      accuracy: number(p.accuracy, 0, 100000) ? p.accuracy : null,
      speed: number(p.speed, 0, 100) ? p.speed : null,
      bearing: number(p.bearing, 0, 360) ? p.bearing : null,
    });
  }
  return { batch: { vehicle, trip, line, direction, points: clean, ended } };
}

/**
 * What to store for a batch: the newest of its points, or null when there's nothing current to
 * store (no points, the trip ended, or the newest is too old or from the future).
 */
export function latestEntry(batch, now = Date.now()) {
  if (batch.ended || batch.points.length === 0) return null;
  const newest = batch.points.reduce((a, b) => (b.time > a.time ? b : a));
  const age = (now - newest.time) / 1000;
  if (age > MAX_POINT_AGE_SECONDS || age < -60) return null;
  return {
    vehicle: batch.vehicle,
    trip: batch.trip,
    line: batch.line,
    direction: batch.direction,
    lat: newest.lat,
    lng: newest.lng,
    bearing: newest.bearing,
    speed: newest.speed,
    accuracy: newest.accuracy,
    t: new Date(newest.time).toISOString(),
    receivedAt: new Date(now).toISOString(),
  };
}

/**
 * The buses on the road, from the Redis hash: the fresh ones for the passengers, and the vehicles
 * gone quiet, to take out. Newest first within a line, lines in order.
 */
export function liveBuses(hash, now = Date.now()) {
  const buses = [];
  const stale = [];
  for (const [vehicle, entry] of Object.entries(hash ?? {})) {
    const at = Date.parse(entry?.receivedAt);
    if (!Number.isFinite(at) || (now - at) / 1000 > FRESH_SECONDS) {
      stale.push(vehicle);
      continue;
    }
    const { trip, accuracy, ...shown } = entry;
    buses.push(shown);
  }
  buses.sort((a, b) => a.line.localeCompare(b.line) || a.vehicle.localeCompare(b.vehicle));
  return { buses, stale };
}

/** Whether `Authorization: Bearer <key>` names one of the keys in DEVICE_KEYS (comma-separated) */
export function keyAllowed(header, deviceKeys) {
  const given = /^Bearer (.+)$/.exec(header ?? "")?.[1]?.trim();
  if (!given) return false;
  const keys = (deviceKeys ?? "").split(",").map((k) => k.trim()).filter(Boolean);
  const a = Buffer.from(given);
  // Compared in constant time, so the answer's timing gives nothing away
  return keys.some((key) => {
    const b = Buffer.from(key);
    return a.length === b.length && timingSafeEqual(a, b);
  });
}
