import { describe, it, expect } from "vitest";
import { getStore } from "../../src/store/index.js";

// No REDIS_URL in the test env → memory backend.
describe("store (memory backend)", () => {
  const store = getStore();

  it("defaults to the in-memory backend without REDIS_URL", () => {
    expect(store.backend).toBe("memory");
  });

  it("round-trips cache values and clears", async () => {
    await store.cacheSet("k1", { a: 1 }, 60);
    expect(await store.cacheGet("k1")).toEqual({ a: 1 });
    await store.cacheClear();
    expect(await store.cacheGet("k1")).toBeUndefined();
  });

  it("accumulates and resets budget per month key", async () => {
    const month = "test-2099-0";
    await store.budgetReset(month);
    expect(await store.budgetGet(month)).toBe(0);
    await store.budgetIncr(month, 0.001);
    await store.budgetIncr(month, 0.002);
    expect(await store.budgetGet(month)).toBeCloseTo(0.003, 6);
    await store.budgetReset(month);
    expect(await store.budgetGet(month)).toBe(0);
  });

  it("ping resolves true", async () => {
    expect(await store.ping()).toBe(true);
  });
});
