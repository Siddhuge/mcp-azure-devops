import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import request from "supertest";
import nock from "nock";
import { createApp } from "../../src/app.js";
import { __setClient, __resetBudget } from "../../src/services/llm.service.js";

const BASE = "https://dev.azure.com";
const app = createApp();

function scriptedClient() {
  let call = 0;
  return {
    messages: {
      create: async () => {
        call += 1;
        if (call === 1) {
          return {
            stop_reason: "tool_use",
            content: [{ type: "tool_use", id: "t1", name: "list_projects", input: {} }],
            usage: { input_tokens: 40, output_tokens: 8 },
          };
        }
        return {
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Projects: Canary." }],
          usage: { input_tokens: 50, output_tokens: 12 },
        };
      },
    },
  };
}

/** Streaming mock: turn 1 tool_use, turn 2 streams text. */
function scriptedStreamClient() {
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
                content: [{ type: "tool_use", id: "t1", name: "list_projects", input: {} }],
                usage: { input_tokens: 40, output_tokens: 8 },
              };
            }
            if (this._t) this._t("Projects: Canary.");
            return {
              stop_reason: "end_turn",
              content: [{ type: "text", text: "Projects: Canary." }],
              usage: { input_tokens: 50, output_tokens: 12 },
            };
          },
        };
      },
    },
  };
}

beforeAll(() => {
  nock.disableNetConnect();
  nock.enableNetConnect("127.0.0.1");
});
beforeEach(() => __resetBudget());
afterEach(() => nock.cleanAll());

describe("POST /chat", () => {
  it("rejects unauthenticated requests", async () => {
    const res = await request(app).post("/chat").send({ messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(401);
  });

  it("validates the body", async () => {
    const res = await request(app)
      .post("/chat")
      .set("Authorization", "Bearer test-token")
      .send({ messages: [] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("answers a question end-to-end (mocked LLM + Azure)", async () => {
    nock(BASE).get("/test-org/_apis/projects").query(true).reply(200, { value: [{ id: "1", name: "Canary" }] });
    __setClient(scriptedClient());

    const res = await request(app)
      .post("/chat")
      .set("Authorization", "Bearer test-token")
      .send({ messages: [{ role: "user", content: "list my projects" }] });

    expect(res.status).toBe(200);
    expect(res.body.reply).toContain("Canary");
    expect(res.body.toolCalls[0].name).toBe("list_projects");
    expect(res.body.costUsd).toBeGreaterThan(0);
  });
});

describe("POST /chat/stream", () => {
  it("rejects unauthenticated requests", async () => {
    const res = await request(app).post("/chat/stream").send({ messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(401);
  });

  it("streams SSE frames end-to-end (mocked LLM + Azure)", async () => {
    nock(BASE).get("/test-org/_apis/projects").query(true).reply(200, { value: [{ id: "1", name: "Canary" }] });
    __setClient(scriptedStreamClient());

    const res = await request(app)
      .post("/chat/stream")
      .set("Authorization", "Bearer test-token")
      .send({ messages: [{ role: "user", content: "list my projects" }] });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
    expect(res.text).toContain("event: tool");
    expect(res.text).toContain("event: delta");
    expect(res.text).toContain("event: done");
    expect(res.text).toContain("Canary");
  });
});
