import { Redis } from "@upstash/redis";

// The same Upstash Redis as astiko-ktel-announcements. Vercel's Storage tab
// connects it under the legacy "KV_" names (KV_REST_API_URL / KV_REST_API_TOKEN),
// not Upstash's own UPSTASH_REDIS_REST_* names, so both work.
const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

export const redis = REDIS_URL && REDIS_TOKEN ? new Redis({ url: REDIS_URL, token: REDIS_TOKEN }) : null;
