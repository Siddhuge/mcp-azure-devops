import { describe, it, expect, beforeAll, afterEach } from "vitest";
import request from "supertest";
import nock from "nock";
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from "jose";
import { createApp } from "../../src/app.js";
import { __setKeyResolver } from "../../src/auth/oidc.js";

const BASE = "https://dev.azure.com";
const app = createApp();
let privateKey;

const baseJwt = () =>
  new SignJWT({ scope: "pipelines.read", email: "user@example.com" })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer("https://issuer.test/")
    .setAudience("mcp-azure-devops")
    .setSubject("user-123")
    .setExpirationTime("5m");

beforeAll(async () => {
  nock.disableNetConnect();
  nock.enableNetConnect("127.0.0.1");
  const { publicKey, privateKey: pk } = await generateKeyPair("RS256");
  privateKey = pk;
  const jwk = await exportJWK(publicKey);
  jwk.kid = "test-key";
  jwk.alg = "RS256";
  __setKeyResolver(createLocalJWKSet({ keys: [jwk] })); // hermetic: no network JWKS fetch
});
afterEach(() => nock.cleanAll());

function projectsNock() {
  nock(BASE).get("/test-org/_apis/projects").query(true).reply(200, { value: [{ id: "1", name: "Canary" }] });
}

describe("auth", () => {
  it("rejects requests with no credential", async () => {
    const res = await request(app).get("/projects");
    expect(res.status).toBe(401);
  });

  it("accepts a named service token (back-compat)", async () => {
    projectsNock();
    const res = await request(app).get("/projects").set("Authorization", "Bearer test-token");
    expect(res.status).toBe(200);
  });

  it("rejects a wrong service token", async () => {
    const res = await request(app).get("/projects").set("Authorization", "Bearer nope");
    expect(res.status).toBe(401);
  });

  it("accepts a valid OIDC JWT", async () => {
    projectsNock();
    const jwt = await baseJwt().sign(privateKey);
    const res = await request(app).get("/projects").set("Authorization", `Bearer ${jwt}`);
    expect(res.status).toBe(200);
  });

  it("rejects a JWT with the wrong audience", async () => {
    const jwt = await new SignJWT({ scope: "pipelines.read" })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer("https://issuer.test/")
      .setAudience("someone-else")
      .setSubject("u")
      .setExpirationTime("5m")
      .sign(privateKey);
    const res = await request(app).get("/projects").set("Authorization", `Bearer ${jwt}`);
    expect(res.status).toBe(401);
  });

  it("rejects an expired JWT", async () => {
    const jwt = await new SignJWT({ scope: "pipelines.read" })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer("https://issuer.test/")
      .setAudience("mcp-azure-devops")
      .setSubject("u")
      .setExpirationTime("-1m")
      .sign(privateKey);
    const res = await request(app).get("/projects").set("Authorization", `Bearer ${jwt}`);
    expect(res.status).toBe(401);
  });

  it("forbids a JWT missing the required scope (403)", async () => {
    const jwt = await new SignJWT({ scope: "other.scope" })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer("https://issuer.test/")
      .setAudience("mcp-azure-devops")
      .setSubject("u")
      .setExpirationTime("5m")
      .sign(privateKey);
    const res = await request(app).get("/projects").set("Authorization", `Bearer ${jwt}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });
});

describe("/metrics", () => {
  it("serves Prometheus text and includes our metrics", async () => {
    const res = await request(app).get("/metrics");
    expect(res.status).toBe(200);
    expect(res.text).toContain("http_requests_total");
    expect(res.text).toMatch(/process_cpu|nodejs_/);
  });
});

describe("/config (public SPA config)", () => {
  it("advertises OIDC mode with the public SPA settings", async () => {
    const res = await request(app).get("/config"); // no auth
    expect(res.status).toBe(200);
    expect(res.body.auth.mode).toBe("oidc");
    expect(res.body.auth.oidc).toMatchObject({
      issuer: "https://issuer.test/",
      clientId: "spa-client-id",
      audience: "mcp-azure-devops",
    });
    expect(res.body.auth.oidc.scopes).toContain("openid");
  });

  it("allows the IdP origin in the CSP connect-src (for PKCE token exchange)", async () => {
    const res = await request(app).get("/healthz");
    expect(res.headers["content-security-policy"]).toMatch(/connect-src[^;]*https:\/\/issuer\.test/);
  });
});
