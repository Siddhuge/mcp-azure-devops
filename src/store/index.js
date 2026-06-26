import Redis from "ioredis";
import { config } from "../config/env.js";
import { logger } from "../config/logger.js";
import { TtlLruCache } from "../utils/cache.js";

const log = logger.child({ module: "store" });

// Budget keys live ~70 days so the previous month's total survives a late read.
const BUDGET_TTL_SECONDS = 70 * 24 * 3600;

/**
 * Shared state backend for the result cache and the LLM monthly-spend counter.
 *
 * Why this exists: with an in-process store, a multi-replica deployment gives
 * each replica its own cache and its own budget counter — so the cost cap is
 * per-process, not global, and resets on restart. Pointing REDIS_URL at a Redis
 * makes both shared and durable. Without REDIS_URL, the in-memory store is used
 * (correct only for a single instance).
 *
 * @typedef {Object} Store
 * @property {string} backend
 * @property {(key:string)=>Promise<unknown|undefined>} cacheGet
 * @property {(key:string,value:unknown,ttlSeconds:number)=>Promise<void>} cacheSet
 * @property {()=>Promise<void>} cacheClear
 * @property {(month:string)=>Promise<number>} budgetGet
 * @property {(month:string,usd:number)=>Promise<void>} budgetIncr
 * @property {(month:string)=>Promise<void>} budgetReset
 * @property {()=>Promise<boolean>} ping
 * @property {()=>Promise<void>} close
 */

/** @returns {Store} */
function createMemoryStore() {
  const cache = new TtlLruCache({
    maxEntries: config.cache.maxEntries,
    ttlSeconds: config.cache.ttlSeconds,
  });
  /** @type {Map<string, number>} */
  const budget = new Map();
  return {
    backend: "memory",
    async cacheGet(key) {
      return cache.get(key);
    },
    async cacheSet(key, value) {
      cache.set(key, value);
    },
    async cacheClear() {
      cache.clear();
    },
    async budgetGet(month) {
      return budget.get(month) || 0;
    },
    async budgetIncr(month, usd) {
      budget.set(month, (budget.get(month) || 0) + usd);
    },
    async budgetReset(month) {
      budget.delete(month);
    },
    async ping() {
      return true;
    },
    async close() {},
  };
}

/**
 * @param {import("ioredis").Redis} redis
 * @returns {Store}
 */
function createRedisStore(redis) {
  const cacheKey = (k) => `cache:${k}`;
  const budgetKey = (m) => `budget:${m}`;
  return {
    backend: "redis",
    client: redis, // exposed for the shared rate-limit store

    async cacheGet(key) {
      try {
        const raw = await redis.get(cacheKey(key));
        return raw ? JSON.parse(raw) : undefined;
      } catch (err) {
        log.warn({ err: err.message }, "redis cacheGet failed");
        return undefined;
      }
    },
    async cacheSet(key, value, ttlSeconds) {
      try {
        const ttl = Math.max(1, ttlSeconds || config.cache.ttlSeconds);
        await redis.set(cacheKey(key), JSON.stringify(value), "EX", ttl);
      } catch (err) {
        log.warn({ err: err.message }, "redis cacheSet failed");
      }
    },
    async cacheClear() {
      try {
        const keys = await redis.keys("cache:*");
        if (keys.length) await redis.del(keys);
      } catch (err) {
        log.warn({ err: err.message }, "redis cacheClear failed");
      }
    },
    async budgetGet(month) {
      try {
        const v = await redis.get(budgetKey(month));
        return v ? parseFloat(v) : 0;
      } catch (err) {
        log.warn({ err: err.message }, "redis budgetGet failed");
        return 0;
      }
    },
    async budgetIncr(month, usd) {
      try {
        const key = budgetKey(month);
        await redis.incrbyfloat(key, usd);
        await redis.expire(key, BUDGET_TTL_SECONDS);
      } catch (err) {
        log.warn({ err: err.message }, "redis budgetIncr failed");
      }
    },
    async budgetReset(month) {
      try {
        await redis.del(budgetKey(month));
      } catch (err) {
        log.warn({ err: err.message }, "redis budgetReset failed");
      }
    },
    async ping() {
      try {
        return (await redis.ping()) === "PONG";
      } catch {
        return false;
      }
    },
    async close() {
      try {
        await redis.quit();
      } catch {
        /* ignore */
      }
    },
  };
}

/** @type {Store|undefined} */
let _store;

/**
 * Get the process-wide store singleton (Redis when REDIS_URL is set, else memory).
 * @returns {Store}
 */
export function getStore() {
  if (_store) return _store;
  if (config.redisUrl) {
    const redis = new Redis(config.redisUrl, {
      maxRetriesPerRequest: 2,
      enableOfflineQueue: true,
    });
    redis.on("error", (err) => log.warn({ err: err.message }, "redis connection error"));
    log.info("using redis store for shared cache + budget");
    _store = createRedisStore(redis);
  } else {
    _store = createMemoryStore();
  }
  return _store;
}

/**
 * The shared ioredis client when REDIS_URL is set, else null. Used by the
 * rate limiter to enforce limits globally across replicas (not per-process).
 * @returns {import("ioredis").Redis | null}
 */
export function getRedisClient() {
  const s = getStore();
  return s.backend === "redis" ? s.client : null;
}

/** Test seam: drop the singleton so a fresh store is created next call. */
export async function __resetStore() {
  if (_store) await _store.close();
  _store = undefined;
}
