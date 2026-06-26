import { describe, it, expect, beforeEach } from "vitest";
import { classifyLines, __store } from "../../src/analyzer/index.js";
import { __setClient, __resetBudget } from "../../src/services/llm.service.js";

const throwingClient = {
  messages: {
    create: async () => {
      throw new Error("LLM should not have been called");
    },
  },
};

function mockLlm(payload) {
  return {
    messages: {
      create: async () => ({
        content: [{ type: "text", text: JSON.stringify(payload) }],
        usage: { input_tokens: 50, output_tokens: 20 },
      }),
    },
  };
}

describe("analyzer.classifyLines", () => {
  beforeEach(async () => {
    await __store.cacheClear();
    await __resetBudget();
  });

  it("classifies via the rule engine without calling the LLM (free tier)", async () => {
    __setClient(throwingClient);
    const result = await classifyLines(["##[error]toomanyrequests: pull rate limit"]);
    expect(result.source).toBe("RULE_ENGINE");
    expect(result.failureType).toBe("INFRA_DOCKER_RATE_LIMIT");
    expect(result.meta.totalLines).toBe(1);
  });

  it("escalates to the LLM on low-confidence matches, then serves from cache", async () => {
    __setClient(
      mockLlm({
        failureType: "CUSTOM_FAILURE",
        rootCause: "weird thing",
        fix: "do something",
        severity: "MEDIUM",
        confidence: 0.7,
      }),
    );

    const lines = ["##[error]some entirely unrecognized failure mode"];
    const first = await classifyLines(lines);
    expect(first.source).toBe("LLM");
    expect(first.failureType).toBe("CUSTOM_FAILURE");

    // Second identical call must hit the cache — swap to a throwing client to prove it.
    __setClient(throwingClient);
    const second = await classifyLines(lines);
    expect(second.source).toBe("CACHE");
    expect(second.failureType).toBe("CUSTOM_FAILURE");
  });

  it("uses timeline issues to classify failures absent from step logs (build 279)", async () => {
    __setClient(throwingClient);
    // Step logs are pure pipeline-YAML/script noise; the real error is in the timeline.
    const noisyLogs = [
      "      timeoutInMinutes: \"25\"",
      "            TIMEOUT=1200   # 20 minutes",
      "            while [ $ELAPSED -lt $TIMEOUT ]; do",
      "        failed('DeployCanary'),",
    ];
    const result = await classifyLines(noisyLogs, {
      timelineErrors: [
        "No agent found in pool aks-canary-poc-agents which satisfies the specified demands: Agent.Version -gtVersion 2.163.1",
      ],
    });
    expect(result.source).toBe("RULE_ENGINE");
    expect(result.failureType).toBe("INFRA_AGENT_UNAVAILABLE");
  });

  it("does not raise a false timeout from echoed pipeline script noise (build 279)", async () => {
    __setClient(throwingClient);
    const noisyLogs = [
      "            TIMEOUT=1200   # 20 minutes",
      "            while [ $ELAPSED -lt $TIMEOUT ]; do",
      "            echo \"✖ Timeout after ${TIMEOUT}s waiting for rollout\"",
    ];
    const result = await classifyLines(noisyLogs); // no timeline, LLM disabled via throwing client
    expect(result.failureType).not.toBe("INFRA_TIMEOUT");
  });

  it("returns a deterministic fallback when no errors are present", async () => {
    __setClient(throwingClient);
    const result = await classifyLines(["everything is fine", "build succeeded"]);
    expect(["FALLBACK", "BUDGET_CAPPED"]).toContain(result.source);
    expect(result.failureType).toBe("UNKNOWN");
  });
});
