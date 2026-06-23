import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import nock from "nock";
import { runChat, runChatStream } from "../../src/agent/chatAgent.js";
import { __setClient, __resetBudget, budgetStatus, recordSpend } from "../../src/services/llm.service.js";

/** Mock streaming client: turn 1 calls a tool, turn 2 streams text deltas. */
function scriptedStreamClient(toolName, toolInput, chunks) {
  let call = 0;
  return {
    messages: {
      stream() {
        const c = ++call;
        return {
          _t: null,
          on(ev, cb) {
            if (ev === "text") this._t = cb;
            return this;
          },
          async finalMessage() {
            if (c === 1) {
              return {
                stop_reason: "tool_use",
                content: [{ type: "tool_use", id: "t1", name: toolName, input: toolInput }],
                usage: { input_tokens: 40, output_tokens: 8 },
              };
            }
            if (this._t) for (const ch of chunks) this._t(ch);
            return {
              stop_reason: "end_turn",
              content: [{ type: "text", text: chunks.join("") }],
              usage: { input_tokens: 50, output_tokens: 12 },
            };
          },
        };
      },
    },
  };
}

const BASE = "https://dev.azure.com";
const PREFIX = "/test-org/test-project/_apis/build";

/** Mock Anthropic client: first turn requests a tool, second turn replies. */
function scriptedClient(toolName, toolInput, finalText) {
  let call = 0;
  return {
    messages: {
      create: async () => {
        call += 1;
        if (call === 1) {
          return {
            stop_reason: "tool_use",
            content: [{ type: "tool_use", id: "t1", name: toolName, input: toolInput }],
            usage: { input_tokens: 50, output_tokens: 10 },
          };
        }
        return {
          stop_reason: "end_turn",
          content: [{ type: "text", text: finalText }],
          usage: { input_tokens: 60, output_tokens: 20 },
        };
      },
    },
  };
}

beforeAll(() => {
  nock.disableNetConnect();
});
beforeEach(() => __resetBudget());
afterEach(() => nock.cleanAll());

describe("chatAgent.runChat", () => {
  it("calls list_projects and returns a reply + tool trace + cost", async () => {
    nock(BASE)
      .get("/test-org/_apis/projects")
      .query(true)
      .reply(200, { value: [{ id: "1", name: "Alpha" }, { id: "2", name: "Beta" }] });
    __setClient(scriptedClient("list_projects", {}, "You have 2 projects: Alpha and Beta."));

    const out = await runChat([{ role: "user", content: "list my projects" }]);
    expect(out.reply).toContain("Alpha");
    expect(out.toolCalls).toEqual([{ name: "list_projects", input: {} }]);
    expect(out.costUsd).toBeGreaterThan(0);
    expect((await budgetStatus()).usd).toBeGreaterThan(0);
  });

  it("routes a build question to analyze_pipeline_failure", async () => {
    nock(BASE).get(`${PREFIX}/builds/55/logs`).query(true).reply(200, { count: 1, value: [{ id: 1 }] });
    nock(BASE).get(`${PREFIX}/builds/55/logs/1`).query(true).reply(200, "##[error]OOMKilled");
    nock(BASE).get(`${PREFIX}/builds/55/timeline`).query(true).reply(200, { records: [] });
    __setClient(scriptedClient("analyze_pipeline_failure", { buildId: "55" }, "Build 55 failed: out of memory."));

    const out = await runChat([{ role: "user", content: "why did build 55 fail?" }]);
    expect(out.toolCalls[0].name).toBe("analyze_pipeline_failure");
    expect(out.reply).toContain("memory");
  });

  it("degrades gracefully (friendly reply, no leak) when the LLM call throws", async () => {
    __setClient({
      messages: {
        create: async () => {
          throw new Error("invalid x-api-key (raw provider detail)");
        },
      },
    });
    const out = await runChat([{ role: "user", content: "list my projects" }]);
    expect(out.reply).toMatch(/^⚠/); // friendly, not a thrown 500
    expect(out.reply).not.toMatch(/x-api-key/); // raw provider detail not leaked
    expect(out.toolCalls).toHaveLength(0);
  });

  it("pauses when the monthly budget is exceeded", async () => {
    // No client/azure mocks needed — should short-circuit before any call.
    const big = 1e9;
    await recordSpend(big);
    const out = await runChat([{ role: "user", content: "list projects" }]);
    expect(out.reply).toMatch(/budget/i);
    expect(out.toolCalls).toHaveLength(0);
    await __resetBudget();
  });
});

describe("chatAgent.runChatStream", () => {
  beforeEach(() => __resetBudget());

  it("streams text deltas, emits a tool event, and a done with cost", async () => {
    nock(BASE)
      .get("/test-org/_apis/projects")
      .query(true)
      .reply(200, { value: [{ id: "1", name: "Canary" }] });
    __setClient(scriptedStreamClient("list_projects", {}, ["You have ", "1 project."]));

    const events = [];
    await runChatStream([{ role: "user", content: "list my projects" }], { onEvent: (e) => events.push(e) });

    const text = events.filter((e) => e.type === "delta").map((e) => e.text).join("");
    const tools = events.filter((e) => e.type === "tool").map((e) => e.name);
    const done = events.find((e) => e.type === "done");
    expect(text).toContain("1 project");
    expect(tools).toContain("list_projects");
    expect(done).toBeTruthy();
    expect(done.costUsd).toBeGreaterThan(0);
  });

  it("streams a friendly message when the budget is exceeded", async () => {
    await recordSpend(1e9);
    const events = [];
    await runChatStream([{ role: "user", content: "hi" }], { onEvent: (e) => events.push(e) });
    expect(events.find((e) => e.type === "delta").text).toMatch(/budget/i);
    expect(events.some((e) => e.type === "done")).toBe(true);
    await __resetBudget();
  });
});
