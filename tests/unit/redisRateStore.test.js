import { describe, it, expect } from "vitest";
import { RedisRateStore } from "../../src/middleware/redisRateStore.js";

/** Minimal in-memory fake of the ioredis commands the store uses. */
function fakeRedis() {
  const counts = new Map();
  const ttls = new Map();
  const self = {
    async incr(k) {
      const v = (counts.get(k) || 0) + 1;
      counts.set(k, v);
      return v;
    },
    async pttl(k) {
      return ttls.has(k) ? ttls.get(k) : -1;
    },
    async pexpire(k, ms) {
      ttls.set(k, ms);
      return 1;
    },
    async decr(k) {
      const v = (counts.get(k) || 0) - 1;
      counts.set(k, v);
      return v;
    },
    async del(k) {
      counts.delete(k);
      ttls.delete(k);
      return 1;
    },
    multi() {
      const ops = [];
      const chain = {
        incr(k) {
          ops.push(["incr", k]);
          return chain;
        },
        pttl(k) {
          ops.push(["pttl", k]);
          return chain;
        },
        async exec() {
          const out = [];
          for (const [op, k] of ops) out.push([null, await self[op](k)]);
          return out;
        },
      };
      return chain;
    },
    _counts: counts,
    _ttls: ttls,
  };
  return self;
}

describe("RedisRateStore", () => {
  it("shares a counter across calls (global, not per-process) and sets the window", async () => {
    const redis = fakeRedis();
    const store = new RedisRateStore(redis, "rl:test:");
    store.init({ windowMs: 60_000 });

    const a = await store.increment("ip-1");
    expect(a.totalHits).toBe(1);
    expect(redis._ttls.get("rl:test:ip-1")).toBe(60_000); // expiry set on first hit
    expect(a.resetTime).toBeInstanceOf(Date);

    const b = await store.increment("ip-1");
    expect(b.totalHits).toBe(2); // same key keeps counting (would be shared across replicas)

    const other = await store.increment("ip-2");
    expect(other.totalHits).toBe(1); // independent key
  });

  it("namespaces keys by prefix so limiters don't collide", async () => {
    const redis = fakeRedis();
    const global = new RedisRateStore(redis, "rl:global:");
    const expensive = new RedisRateStore(redis, "rl:expensive:");
    global.init({ windowMs: 1000 });
    expensive.init({ windowMs: 1000 });
    await global.increment("k");
    await global.increment("k");
    const e = await expensive.increment("k");
    expect(e.totalHits).toBe(1); // separate namespace
    expect(redis._counts.get("rl:global:k")).toBe(2);
  });

  it("resetKey and decrement work", async () => {
    const redis = fakeRedis();
    const store = new RedisRateStore(redis, "rl:test:");
    store.init({ windowMs: 1000 });
    await store.increment("k");
    await store.increment("k");
    await store.decrement("k");
    expect(redis._counts.get("rl:test:k")).toBe(1);
    await store.resetKey("k");
    expect(redis._counts.has("rl:test:k")).toBe(false);
  });
});
