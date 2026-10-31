// Where the buses are.
//
//   POST /api/positions   the drivers' phones send their positions (needs a device key)
//   GET  /api/positions   the passenger app reads the buses on the road
//
// Each call is one Redis command, to stay well inside the free plans: a phone
// sends every 30 seconds, and the GET is cached at the edge for 10 seconds
// however many passengers ask.

import { redis } from "../lib/store.js";
import { LIVE_KEY, keyAllowed, latestEntry, liveBuses, parseBatch } from "../lib/positions.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "GET") return read(req, res);
  if (req.method === "POST") return write(req, res);
  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Use GET or POST" });
}

async function read(req, res) {
  if (!redis) return res.status(503).json({ error: "No database connected" });
  const now = Date.now();
  const { buses, stale } = liveBuses(await redis.hgetall(LIVE_KEY), now);
  // Buses gone quiet without ending their trip (the phone lost signal or power) are tidied away
  if (stale.length) await redis.hdel(LIVE_KEY, ...stale);
  res.setHeader("Cache-Control", "public, s-maxage=10, stale-while-revalidate=10");
  return res.status(200).json({ updated: new Date(now).toISOString(), buses });
}

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
