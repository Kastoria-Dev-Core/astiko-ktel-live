/**
 * Where the buses are: the one endpoint, `/api/positions`.
 *
 * - `POST`: the drivers' phones send their positions (needs a device key)
 * - `GET`: the passenger app reads the buses on the road
 *
 * Each call is one Redis command, to stay well inside the free plans: a phone sends every
 * 30 seconds, and the GET is cached at the edge for 10 seconds however many passengers ask.
 *
 * @module api/positions
 */

import { redis } from "../lib/store.js";
import { LIVE_KEY, keyAllowed, latestEntry, liveBuses, parseBatch } from "../lib/positions.js";

/**
 * The Vercel function: GET to {@link read}, POST to {@link write}, anything else 405.
 *
 * @param {object} req The request; Vercel has parsed a JSON body into `req.body`
 * @param {object} res Vercel's response, with `status()` and `json()`
 * @returns {Promise<void>}
 */
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "GET") return read(req, res);
  if (req.method === "POST") return write(req, res);
  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Use GET or POST" });
}

/**
 * `GET`: the buses heard from in the last two minutes, as `{ updated, buses }`. Tidies away the
 * vehicles gone quiet without ending their trip.
 *
 * @param {object} req The request
 * @param {object} res The response
 * @returns {Promise<void>} 200 with the buses, or 503 with no database
 */
async function read(req, res) {
  if (!redis) return res.status(503).json({ error: "No database connected" });
  const now = Date.now();
  const { buses, stale } = liveBuses(await redis.hgetall(LIVE_KEY), now);
  // Buses gone quiet without ending their trip (the phone lost signal or power) are tidied away
  if (stale.length) await redis.hdel(LIVE_KEY, ...stale);
  res.setHeader("Cache-Control", "public, s-maxage=10, stale-while-revalidate=10");
  return res.status(200).json({ updated: new Date(now).toISOString(), buses });
}

/**
 * `POST`: a phone's batch. Keeps the bus's newest position, or takes the bus off when the trip ended.
 *
 * @param {object} req The request, with the device key and the batch
 * @param {object} res The response
 * @returns {Promise<void>} 200 stored (or nothing to store, or the connection test), 400 a malformed
 *   batch, 401 an unknown key, 503 with no database
 */
async function write(req, res) {
  if (!keyAllowed(req.headers.authorization, process.env.DEVICE_KEYS)) {
    return res.status(401).json({ error: "Unknown device key" });
  }
  const { batch, error } = parseBatch(req.body);
  if (error) return res.status(400).json({ error });
  // "Δοκιμή σύνδεσης" in the app's setup: the key works, nothing to store
  if (batch.trip === "test") return res.status(200).json({ ok: true, test: true });
  if (!redis) return res.status(503).json({ error: "No database connected" });

  if (batch.ended) {
    await redis.hdel(LIVE_KEY, batch.vehicle);
  } else {
    const entry = latestEntry(batch);
    if (entry) await redis.hset(LIVE_KEY, { [batch.vehicle]: entry });
  }
  return res.status(200).json({ ok: true });
}
