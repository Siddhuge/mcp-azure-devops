import { describe, it, expect } from "vitest";
import {
  stripTimestamp,
  filterRelevant,
  normalizeForHash,
  dedupe,
  bucketize,
  isNoise,
} from "../../src/utils/logParser.js";

describe("logParser", () => {
  it("strips Azure timestamps and ANSI codes", () => {
    expect(stripTimestamp("2024-01-01T12:00:00.1234567Z ##[error]boom")).toBe("##[error]boom");
  });

  it("keeps only relevant lines", () => {
    const lines = ["all good", "##[error]failed step", "info: starting", "WARNING: deprecated"];
    expect(filterRelevant(lines)).toEqual(["##[error]failed step", "WARNING: deprecated"]);
  });

  it("normalizes volatile tokens so re-runs hash equally", () => {
    const a = normalizeForHash("2024-01-01T00:00:00Z Error at build 12345 hash a1b2c3d4e5f6");
    const b = normalizeForHash("2024-02-02T00:00:00Z Error at build 99999 hash f6e5d4c3b2a1");
    expect(a).toBe(b);
  });

  it("dedupes lines that normalize equally", () => {
    const out = dedupe(["Error on line 1", "Error on line 2", "Different error"]);
    expect(out).toHaveLength(2);
  });

  it("flags pipeline noise (debug traces, expression eval, scan tables)", () => {
    expect(isNoise("##[debug]Evaluating condition")).toBe(true);
    expect(isNoise("Evaluating: in(pair['key'], 'timeoutInMinutes')")).toBe(true);
    expect(isNoise("│ app/node_modules/es-errors/package.json │ node-pkg │")).toBe(true);
    expect(isNoise("##[error]Bash exited with code '1'.")).toBe(false);
  });

  it("drops the expression-eval line that previously caused a false timeout match", () => {
    const lines = [
      "Evaluating: in(pair['key'], 'displayName', 'timeoutInMinutes')",
      "##[error]Bash exited with code '1'.",
    ];
    expect(filterRelevant(lines)).toEqual(["##[error]Bash exited with code '1'."]);
  });

  it("drops terraform plan diff rows that merely mention a keyword (build 241)", () => {
    expect(isNoise("        - timeout = 30 -> null")).toBe(true);
    expect(isNoise("        ~ tags    = {}")).toBe(true);
    expect(isNoise("ERROR: SSH never became ready after 5 minutes")).toBe(false);
  });

  it("buckets errors vs warnings", () => {
    const { errors, warnings } = bucketize(["##[error]x", "WARNING: y"]);
    expect(errors).toEqual(["##[error]x"]);
    expect(warnings).toEqual(["WARNING: y"]);
  });
});
