import { describe, it, expect, beforeAll, afterEach } from "vitest";
import nock from "nock";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../../src/mcp/server.js";

const BASE = "https://dev.azure.com";
const PREFIX = "/test-org/test-project/_apis/build";

async function connectedClient() {
  const server = createMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

beforeAll(() => nock.disableNetConnect());
afterEach(() => nock.cleanAll());

describe("MCP server", () => {
  it("lists the expected tools", async () => {
    const { client } = await connectedClient();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "analyze_pipeline_failure",
      "get_build_logs",
      "get_log_content",
      "list_projects",
      "list_recent_builds",
    ]);
  });

  it("analyze_pipeline_failure returns structured classification JSON", async () => {
    nock(BASE)
      .get(`${PREFIX}/builds/777/logs`)
      .query(true)
      .reply(200, { count: 1, value: [{ id: 1 }] });
    nock(BASE)
      .get(`${PREFIX}/builds/777/logs/1`)
      .query(true)
      .reply(200, "##[error]OOMKilled: container ran out of memory");
    nock(BASE).get(`${PREFIX}/builds/777/timeline`).query(true).reply(200, { records: [] });

    const { client } = await connectedClient();
    const res = await client.callTool({
      name: "analyze_pipeline_failure",
      arguments: { buildId: "777" },
    });
    const payload = JSON.parse(res.content[0].text);
    expect(payload.source).toBe("RULE_ENGINE");
    expect(payload.failureType).toBe("INFRA_OOM");
  });

  it("returns an MCP error result on upstream failure", async () => {
    nock(BASE).get(`${PREFIX}/builds/404/logs`).query(true).reply(404, "nope");
    nock(BASE).get(`${PREFIX}/builds/404/timeline`).query(true).reply(404, "nope");
    const { client } = await connectedClient();
    const res = await client.callTool({
      name: "analyze_pipeline_failure",
      arguments: { buildId: "404" },
    });
    expect(res.isError).toBe(true);
  });
});
