/**
 * What the server does with positions, apart from Redis: checking what a phone sent, keeping the
 * latest position of each bus, and which buses are on the road. Pure functions, so `npm test` can
 * check them without a database.
 *
 * @module lib/positions
 */

import { timingSafeEqual } from "node:crypto";

/**
 * One position as a phone sends it.
 *
 * @typedef {object} SentPoint
 * @property {string} t When the phone got it, ISO 8601, e.g. "2026-10-31T08:15:02Z"
 * @property {number} lat Latitude, WGS84
 * @property {number} lng Longitude, WGS84
 * @property {number} [accuracy] Metres the real position is likely within
 * @property {number} [speed] Metres per second
 * @property {number} [bearing] Degrees clockwise from north
 */

/**
 * A position once checked: the time as milliseconds, odd optional values dropped.
 *
 * @typedef {object} Point
 * @property {number} time When the phone got it, milliseconds since the epoch
 * @property {number} lat Latitude, WGS84
 * @property {number} lng Longitude, WGS84
 * @property {?number} accuracy Metres, or null
 * @property {?number} speed Metres per second, or null
 * @property {?number} bearing Degrees from north, or null
 */

/**
 * A batch of positions of one trip, as the drivers' app sends it and once checked.
 *
 * @typedef {object} Batch
 * @property {string} vehicle The bus, e.g. "12"; one position is kept per vehicle
 * @property {string} trip New at every start and change of direction; "test" for the app's connection test
 * @property {string} line The line's id in the passenger app's data, e.g. "04"
 * @property {string} direction "out" or "in"
 * @property {Point[]} points Oldest first
 * @property {boolean} ended The trip is over: the bus comes off the map
 */

/**
 * What's stored in Redis for a bus: its newest position and when it came.
 *
 * @typedef {object} Entry
 * @property {string} vehicle The bus
 * @property {string} trip Its trip; not passed on to the passengers
 * @property {string} line The line's id
 * @property {string} direction "out" or "in"
 * @property {number} lat Latitude, WGS84
 * @property {number} lng Longitude, WGS84
 * @property {?number} bearing Degrees from north, or null
 * @property {?number} speed Metres per second, or null
 * @property {?number} accuracy Metres, or null; not passed on to the passengers
 * @property {string} t When the phone got the position, ISO 8601
 * @property {string} receivedAt When the server got it, ISO 8601
 */

/**
 * A bus as the passenger app gets it: an {@link Entry} without its trip and accuracy.
 *
 * @typedef {object} LiveBus
 * @property {string} vehicle The bus
 * @property {string} line The line's id
 * @property {string} direction "out" or "in"
 * @property {number} lat Latitude, WGS84
 * @property {number} lng Longitude, WGS84
 * @property {?number} bearing Degrees from north, or null
 * @property {?number} speed Metres per second, or null
 * @property {string} t When the phone got the position, ISO 8601
 * @property {string} receivedAt When the server got it, ISO 8601
 */

/** One Redis hash, field = vehicle, value = its latest position */
export const LIVE_KEY = "astiko-ktel:live";

/** A bus not heard from for this long is no longer shown */
export const FRESH_SECONDS = 120;

/** A position this old when it arrives was held back with no signal: history, not where the bus is */
export const MAX_POINT_AGE_SECONDS = 180;

/** At most this many points in one batch; the app sends up to 200 */
export const MAX_POINTS = 500;

/**
 * A string of 1 to `max` characters.
 *
 * @private
 * @param {*} value What came in the batch
 * @param {number} max The longest allowed
 * @returns {boolean}
 */
const text = (value, max) => typeof value === "string" && value.length > 0 && value.length <= max;
/**
 * A finite number from `min` to `max`.
 *
 * @private
 * @param {*} value What came in the batch
 * @param {number} min The smallest allowed
 * @param {number} max The largest allowed
 * @returns {boolean}
 */
const number = (value, min, max) => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;

/**
 * Checks a batch from a phone (see the README for its shape). Returns `{ batch }` with only the
 * fields the server uses, or `{ error }` saying what's wrong.
 *
 * @param {object|string} body The request body, parsed or as the JSON text
 * @returns {{batch: Batch}|{error: string}}
 * @example
 * parseBatch({ vehicle: "12", trip: "a", line: "04", direction: "out", points: [] })
 * // => { batch: { vehicle: "12", trip: "a", line: "04", direction: "out", points: [], ended: false } }
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
 *
 * @param {Batch} batch A batch from {@link parseBatch}
 * @param {number} [now=Date.now()] Milliseconds since the epoch, for the tests
 * @returns {?Entry}
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
 * gone quiet, to take out. Lines in order, and vehicles in order within a line.
 *
 * @param {?Object<string, Entry>} hash The hash at {@link LIVE_KEY}, vehicle to entry
 * @param {number} [now=Date.now()] Milliseconds since the epoch, for the tests
 * @returns {{buses: LiveBus[], stale: string[]}} The buses to show, and the vehicles to delete
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

/**
 * Whether `Authorization: Bearer <key>` names one of the keys in DEVICE_KEYS (comma-separated).
 * Compared in constant time, so the answer's timing gives nothing away.
 *
 * @param {string|undefined} header The request's Authorization header
 * @param {string|undefined} deviceKeys The DEVICE_KEYS environment variable
 * @returns {boolean}
 */
export function keyAllowed(header, deviceKeys) {
  const given = /^Bearer (.+)$/.exec(header ?? "")?.[1]?.trim();
  if (!given) return false;
  const keys = (deviceKeys ?? "").split(",").map((k) => k.trim()).filter(Boolean);
  const a = Buffer.from(given);
  return keys.some((key) => {
    const b = Buffer.from(key);
    return a.length === b.length && timingSafeEqual(a, b);
  });
}
