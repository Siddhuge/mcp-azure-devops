import { describe, it, expect, beforeAll, afterEach } from "vitest";
import request from "supertest";
import nock from "nock";
import { createApp } from "../../src/app.js";
import { __store } from "../../src/analyzer/index.js";

const BASE = "https://dev.azure.com";
const PREFIX = "/test-org/test-project/_apis/build";
const app = createApp();

beforeAll(() => {
  nock.disableNetConnect();
  nock.enableNetConnect("127.0.0.1"); // allow supertest's loopback server
});
afterEach(async () => {
  nock.cleanAll();
  await __store.cacheClear();
});

describe("REST API", () => {
  it("exposes a public health probe", async () => {
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  it("rejects unauthenticated requests to protected routes", async () => {
    const res = await request(app).get("/logs/123/classify");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
  });

  it("rejects non-numeric build ids with 400", async () => {
    const res = await request(app)
      .get("/logs/not-a-number/classify")
      .set("Authorization", "Bearer test-token");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("classifies a Docker rate-limit failure via the rule engine", async () => {
    nock(BASE)
      .get(`${PREFIX}/builds/123/logs`)
      .query(true)
      .reply(200, { count: 1, value: [{ id: 1 }] });
    nock(BASE)
      .get(`${PREFIX}/builds/123/logs/1`)
      .query(true)
      .reply(200, "##[error]toomanyrequests: You have reached your pull rate limit");
    nock(BASE).get(`${PREFIX}/builds/123/timeline`).query(true).reply(200, { records: [] });

    const res = await request(app)
      .get("/logs/123/classify")
      .set("Authorization", "Bearer test-token");

    expect(res.status).toBe(200);
    expect(res.body.source).toBe("RULE_ENGINE");
    expect(res.body.failureType).toBe("INFRA_DOCKER_RATE_LIMIT");
  });

  it("targets a different project via ?project= (org-level)", async () => {
    const P = "/test-org/Canary/_apis/build";
    nock(BASE).get(`${P}/builds/308/logs`).query(true).reply(200, { count: 1, value: [{ id: 1 }] });
    nock(BASE).get(`${P}/builds/308/logs/1`).query(true).reply(200, "##[error]OOMKilled");
    nock(BASE).get(`${P}/builds/308/timeline`).query(true).reply(200, { records: [] });

    const res = await request(app)
      .get("/logs/308/classify?project=Canary")
      .set("Authorization", "Bearer test-token");
    expect(res.status).toBe(200);
    expect(res.body.failureType).toBe("INFRA_OOM");
  });

  it("lists organization projects", async () => {
    nock(BASE).get("/test-org/_apis/projects").query(true).reply(200, { value: [{ id: "1", name: "Canary" }] });
    const res = await request(app).get("/projects").set("Authorization", "Bearer test-token");
    expect(res.status).toBe(200);
    expect(res.body[0].name).toBe("Canary");
  });

  it("maps Azure auth failures to a typed error response", async () => {
    nock(BASE).get(`${PREFIX}/builds/123/logs`).query(true).reply(401, "denied");
    const res = await request(app)
      .get("/logs/123")
      .set("Authorization", "Bearer test-token");
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("AZURE_AUTH_ERROR");
  });
});
