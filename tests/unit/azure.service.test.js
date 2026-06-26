import { describe, it, expect, afterEach, beforeAll } from "vitest";
import nock from "nock";
import {
  getBuildLogs,
  getLogContent,
  getAllLogLines,
  listProjects,
} from "../../src/services/azure.service.js";
import { AzureAuthError, BuildNotFoundError } from "../../src/utils/errors.js";

const BASE = "https://dev.azure.com";
const PREFIX = "/test-org/test-project/_apis/build";

beforeAll(() => {
  nock.disableNetConnect();
});

afterEach(() => {
  nock.cleanAll();
});

describe("azure.service", () => {
  it("returns build log metadata", async () => {
    nock(BASE)
      .get(`${PREFIX}/builds/123/logs`)
      .query(true)
      .reply(200, { count: 1, value: [{ id: 1 }] });

    const data = await getBuildLogs("123");
    expect(data.value).toHaveLength(1);
  });

  it("retries transient 5xx then succeeds", async () => {
    nock(BASE).get(`${PREFIX}/builds/123/logs`).query(true).reply(503, "down");
    nock(BASE)
      .get(`${PREFIX}/builds/123/logs`)
      .query(true)
      .reply(200, { count: 0, value: [] });

    const data = await getBuildLogs("123");
    expect(data.value).toEqual([]);
  });

  it("does NOT retry a 404 and throws BuildNotFoundError", async () => {
    nock(BASE).get(`${PREFIX}/builds/999/logs`).query(true).reply(404, "nope");
    await expect(getBuildLogs("999")).rejects.toBeInstanceOf(BuildNotFoundError);
  });

  it("maps 401 to AzureAuthError", async () => {
    nock(BASE).get(`${PREFIX}/builds/123/logs`).query(true).reply(401, "denied");
    await expect(getBuildLogs("123")).rejects.toBeInstanceOf(AzureAuthError);
  });

  it("detects HTML sign-in pages as auth errors", async () => {
    nock(BASE)
      .get(`${PREFIX}/builds/123/logs/5`)
      .query(true)
      .reply(200, "<!DOCTYPE html><html>sign in</html>");
    await expect(getLogContent("123", "5")).rejects.toBeInstanceOf(AzureAuthError);
  });

  it("targets an explicit project when one is provided (org-level)", async () => {
    nock(BASE)
      .get("/test-org/OtherProject/_apis/build/builds/55/logs")
      .query(true)
      .reply(200, { count: 1, value: [{ id: 9 }] });
    const data = await getBuildLogs("55", "OtherProject");
    expect(data.value[0].id).toBe(9);
  });

  it("lists organization projects (org-level discovery)", async () => {
    nock(BASE)
      .get("/test-org/_apis/projects")
      .query(true)
      .reply(200, { count: 2, value: [{ id: "a", name: "Proj1" }, { id: "b", name: "Proj2" }] });
    const projects = await listProjects();
    expect(projects.map((p) => p.name)).toEqual(["Proj1", "Proj2"]);
  });

  it("aggregates all log lines for a build", async () => {
    nock(BASE)
      .get(`${PREFIX}/builds/123/logs`)
      .query(true)
      .reply(200, { count: 2, value: [{ id: 1 }, { id: 2 }] });
    nock(BASE).get(`${PREFIX}/builds/123/logs/1`).query(true).reply(200, "a\nb");
    nock(BASE).get(`${PREFIX}/builds/123/logs/2`).query(true).reply(200, "c");

    const lines = await getAllLogLines("123");
    expect(lines).toEqual(["a", "b", "c"]);
  });
});
