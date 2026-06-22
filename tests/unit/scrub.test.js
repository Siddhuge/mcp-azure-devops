import { describe, it, expect } from "vitest";
import { redactSensitive, redactLines } from "../../src/utils/scrub.js";

describe("redactSensitive", () => {
  it("redacts Azure subscription / SP GUIDs", () => {
    const line =
      "client 'fb732c77-d462-42bf-a4d6-cd31942d662a' over scope '/subscriptions/5972c422-e2f7-41f9-ab8e-7ce76db35969/...'";
    const out = redactSensitive(line);
    expect(out).not.toMatch(/fb732c77|5972c422/);
    expect(out).toContain("<guid>");
  });

  it("redacts IPv4 addresses", () => {
    expect(redactSensitive("azureuser@20.219.138.223: Permission denied")).toContain("<ip>");
    expect(redactSensitive("azureuser@20.219.138.223: Permission denied")).not.toMatch(/20\.219/);
  });

  it("redacts JWTs and known token formats", () => {
    expect(redactSensitive("token eyJhbGciOiJIUzI1Ni1.eyJzdWIiOiIxMjM0NTY.SflKxwRJSMeKKF2QT4")).toContain("<jwt>");
    expect(redactSensitive("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")).toContain("<github-token>");
    expect(redactSensitive("AKIAIOSFODNN7EXAMPLE used")).toContain("<aws-key>");
  });

  it("redacts emails and key=value secrets", () => {
    expect(redactSensitive("contact dev@example.com")).toContain("<email>");
    expect(redactSensitive("AccountKey=abcd1234efgh5678;Endpoint=x")).toContain("AccountKey=<redacted>");
    expect(redactSensitive('password: "hunter2supersecret"')).toContain("<redacted>");
  });

  it("leaves ordinary log text intact", () => {
    const line = "##[error]npm ERR! ERESOLVE unable to resolve dependency tree";
    expect(redactSensitive(line)).toBe(line);
  });

  it("redactLines maps over an array", () => {
    const out = redactLines(["build 1.2.3.4 failed", "ok"]);
    expect(out[0]).toContain("<ip>");
    expect(out[1]).toBe("ok");
  });

  it("passes non-strings through unchanged", () => {
    expect(redactSensitive(42)).toBe(42);
  });
});
