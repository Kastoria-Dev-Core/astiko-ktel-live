/**
 * The database: the same Upstash Redis as astiko-ktel-announcements.
 *
 * @module lib/store
 */

import { Redis } from "@upstash/redis";

/**
 * The store's REST address. Vercel's Storage tab connects it under the legacy "KV_" names
 * (KV_REST_API_URL / KV_REST_API_TOKEN), not Upstash's own UPSTASH_REDIS_REST_* names, so both work.
 *
 * @private
 * @type {string|undefined}
 */
const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;

/**
 * The store's token, from the same variables as {@link REDIS_URL}.
 *
 * @private
 * @type {string|undefined}
 */
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

/**
 * The Redis client, or null when no store is connected: the API then answers 503.
 *
 * @type {?Redis}
 */
export const redis = REDIS_URL && REDIS_TOKEN ? new Redis({ url: REDIS_URL, token: REDIS_TOKEN }) : null;
