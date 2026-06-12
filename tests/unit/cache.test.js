import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TtlLruCache, hashLines } from "../../src/utils/cache.js";

describe("TtlLruCache", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("stores and retrieves values", () => {
    const c = new TtlLruCache({ maxEntries: 10, ttlSeconds: 60 });
    c.set("a", { x: 1 });
    expect(c.get("a")).toEqual({ x: 1 });
    expect(c.has("a")).toBe(true);
  });

  it("expires entries after the TTL", () => {
    const c = new TtlLruCache({ maxEntries: 10, ttlSeconds: 1 });
    c.set("a", 1);
    vi.advanceTimersByTime(1500);
    expect(c.get("a")).toBeUndefined();
  });

  it("evicts the least-recently-used entry when over capacity", () => {
    const c = new TtlLruCache({ maxEntries: 2, ttlSeconds: 60 });
    c.set("a", 1);
    c.set("b", 2);
    c.get("a"); // 'a' is now most-recently-used
    c.set("c", 3); // evicts 'b'
    expect(c.has("a")).toBe(true);
    expect(c.has("b")).toBe(false);
    expect(c.has("c")).toBe(true);
  });

  it("hashLines is stable and order-sensitive", () => {
    expect(hashLines(["x", "y"])).toBe(hashLines(["x", "y"]));
    expect(hashLines(["x", "y"])).not.toBe(hashLines(["y", "x"]));
  });
});
