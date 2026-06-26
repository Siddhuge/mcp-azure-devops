import { describe, it, expect } from "vitest";
import { mapWithConcurrency } from "../../src/utils/concurrency.js";

describe("mapWithConcurrency", () => {
  it("preserves order", async () => {
    const out = await mapWithConcurrency([1, 2, 3, 4, 5], async (n) => n * 2, 2);
    expect(out).toEqual([2, 4, 6, 8, 10]);
  });

  it("never exceeds the concurrency limit", async () => {
    let active = 0;
    let peak = 0;
    await mapWithConcurrency(
      Array.from({ length: 20 }, (_, i) => i),
      async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active -= 1;
      },
      4,
    );
    expect(peak).toBeLessThanOrEqual(4);
  });

  it("handles empty input and limit >= length", async () => {
    expect(await mapWithConcurrency([], async (x) => x, 4)).toEqual([]);
    expect(await mapWithConcurrency([1, 2], async (x) => x + 1, 10)).toEqual([2, 3]);
  });
});
