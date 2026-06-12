import { describe, it, expect, beforeEach } from "vitest";
import {
  analyzeWithLlm,
  estimateCost,
  budgetStatus,
  llmAvailable,
  __setClient,
  __resetBudget,
} from "../../src/services/llm.service.js";
import { LlmError } from "../../src/utils/errors.js";

function mockClient(payload, { usage } = {}) {
  return {
    messages: {
      create: async () => ({
        content: [{ type: "text", text: JSON.stringify(payload) }],
        usage: usage || { input_tokens: 100, output_tokens: 50 },
      }),
    },
  };
}

describe("llm.service", () => {
  beforeEach(() => __resetBudget());

  it("estimates cost from usage (Haiku pricing)", () => {
    // 1,000,000 input → $1, 1,000,000 output → $5
    expect(estimateCost({ input_tokens: 1_000_000 })).toBeCloseTo(1.0, 5);
    expect(estimateCost({ output_tokens: 1_000_000 })).toBeCloseTo(5.0, 5);
  });

  it("returns a structured classification and accrues spend", async () => {
    __setClient(
      mockClient({
        failureType: "INFRA_TIMEOUT",
        rootCause: "Step timed out after 60m",
        fix: "Increase the timeout",
        severity: "MEDIUM",
        confidence: 0.8,
      }),
    );

    const before = budgetStatus().usd;
    const result = await analyzeWithLlm(["##[error]timed out"]);
    expect(result.source).toBe("LLM");
    expect(result.failureType).toBe("INFRA_TIMEOUT");
    expect(result.confidence).toBe(0.8);
    expect(budgetStatus().usd).toBeGreaterThan(before);
  });

  it("clamps out-of-range confidence and bad severity", async () => {
    __setClient(
      mockClient({
        failureType: "X",
        rootCause: "y",
        fix: "z",
        severity: "CRITICAL",
        confidence: 5,
      }),
    );
    const result = await analyzeWithLlm(["err"]);
    expect(result.confidence).toBe(1);
    expect(result.severity).toBe("MEDIUM");
  });

  it("wraps unparseable output in LlmError", async () => {
    __setClient({ messages: { create: async () => ({ content: [{ type: "text", text: "not json" }], usage: {} }) } });
    await expect(analyzeWithLlm(["err"])).rejects.toBeInstanceOf(LlmError);
  });

  it("reports availability based on budget", () => {
    expect(llmAvailable()).toBe(true);
  });
});
