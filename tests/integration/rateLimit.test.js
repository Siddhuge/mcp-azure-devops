import { describe, it, expect, afterAll, vi } from "vitest";
import request from "supertest";

// These tests re-import the module graph with overridden env so the limiters
// pick up custom values (limits are read from config at import time).
const ORIG = process.env.RATE_LIMIT_GLOBAL_MAX;

describe("rate limiting", () => {
  afterAll(() => {
    if (ORIG === undefined) delete process.env.RATE_LIMIT_GLOBAL_MAX;
    else process.env.RATE_LIMIT_GLOBAL_MAX = ORIG;
    vi.resetModules();
  });

  it("reads limits from env into config", async () => {
    vi.resetModules();
    process.env.RATE_LIMIT_GLOBAL_MAX = "7";
    const { config } = await import("../../src/config/env.js");
    expect(config.rateLimit.globalMax).toBe(7);
    expect(config.rateLimit.identityMax).toBe(120); // default unchanged
  });

  it("enforces the global limit with 429 RATE_LIMITED", async () => {
    vi.resetModules();
    process.env.RATE_LIMIT_GLOBAL_MAX = "3";
    const { createApp } = await import("../../src/app.js");
    const app = createApp();

    // The global limiter runs before auth, so even unauthenticated requests
    // (which would otherwise 401) count — once over the limit we get 429.
    let limited = null;
    for (let i = 0; i < 6; i++) {
      const res = await request(app).get("/projects");
      if (res.status === 429) {
        limited = res;
        break;
      }
    }
    expect(limited).not.toBeNull();
    expect(limited.body.error.code).toBe("RATE_LIMITED");
  });
});
