import { describe, it, expect } from "vitest";
import { runRules } from "../../src/utils/ruleEngine.js";

describe("ruleEngine", () => {
  it("matches Docker rate limit with highest priority", () => {
    const match = runRules(["You have reached your pull rate limit (toomanyrequests)"], []);
    expect(match).not.toBeNull();
    expect(match.rule.failureType).toBe("INFRA_DOCKER_RATE_LIMIT");
    expect(match.rule.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("prefers the higher-priority rule when multiple patterns match", () => {
    // Contains both a rate-limit (prio 100) and a generic non-zero exit (prio 30).
    const lines = ["##[error]toomanyrequests", "Process exited with code 1"];
    const match = runRules(lines, []);
    expect(match.rule.name).toBe("DOCKER_RATE_LIMIT");
  });

  it("classifies an agent-pool allocation failure (build 279, from timeline)", () => {
    const match = runRules(
      ["No agent found in pool aks-canary-poc-agents which satisfies the specified demands: Agent.Version -gtVersion 2.163.1"],
      [],
    );
    expect(match.rule.failureType).toBe("INFRA_AGENT_UNAVAILABLE");
  });

  it("classifies a lost agent (build 241, from timeline)", () => {
    const match = runRules(
      ["We stopped hearing from agent blue-green-agent. Verify the agent machine is running and has a healthy network connection."],
      [],
    );
    expect(match.rule.failureType).toBe("INFRA_AGENT_UNAVAILABLE");
  });

  it("classifies SSH key/auth failures (builds 253/254/258)", () => {
    expect(runRules(["azureuser@20.219.138.223: Permission denied (publickey)."], [])?.rule.failureType).toBe("SSH_AUTH_FAILURE");
    expect(runRules(['Load key "/home/azureuser/.ssh/id_rsa": error in libcrypto'], [])?.rule.failureType).toBe("SSH_AUTH_FAILURE");
  });

  it("classifies OOM kills", () => {
    const match = runRules(["Container OOMKilled"], []);
    expect(match.rule.failureType).toBe("INFRA_OOM");
  });

  it("classifies npm dependency failures", () => {
    const match = runRules(["npm ERR! ERESOLVE unable to resolve dependency tree"], []);
    expect(match.rule.failureType).toBe("BUILD_DEPENDENCY");
  });

  it("classifies a filesystem permission error as FS_PERMISSION, not auth (build 284)", () => {
    const match = runRules(
      ["install: cannot remove '/usr/local/bin/trivy': Permission denied", "##[error]Script failed with exit code: 1"],
      [],
    );
    expect(match.rule.failureType).toBe("FS_PERMISSION");
  });

  it("still classifies ACR/credential denials as AUTH_FAILURE (builds 306/315)", () => {
    const match = runRules(
      ["* remote error: GET https://acr.azurecr.io/oauth2/token: UNAUTHORIZED: authentication required"],
      [],
    );
    expect(match.rule.failureType).toBe("AUTH_FAILURE");
  });

  it("falls through to deprecation warnings only when nothing else matches", () => {
    const match = runRules([], ["WARNING: this API is deprecated"]);
    expect(match.rule.failureType).toBe("CONFIG_DEPRECATED");
  });

  it("does NOT match the timeoutInMinutes schema keyword (regression: build 320)", () => {
    const match = runRules(["Evaluating: in(pair['key'], 'timeoutInMinutes', 'enabled')"], []);
    expect(match).toBeNull();
  });

  it("matches a genuine rollout timeout (regression: build 320)", () => {
    const match = runRules(["✖ Timeout after 1200s waiting for rollout"], []);
    expect(match.rule.failureType).toBe("INFRA_TIMEOUT");
  });

  it("reports the failure line, not a script's variable declaration (build 320)", () => {
    const match = runRules(
      ["          TIMEOUT=1200   # 20 minutes", "✖ Timeout after 1200s waiting for rollout"],
      [],
    );
    expect(match.rule.failureType).toBe("INFRA_TIMEOUT");
    expect(match.matchedLine).toContain("Timeout after 1200s");
  });

  it("prefers runtime output over the echo source line (build 320)", () => {
    const match = runRules(
      [
        '          echo "✖ Timeout after ${TIMEOUT}s waiting for rollout"',
        "✖ Timeout after 1200s waiting for rollout",
      ],
      [],
    );
    expect(match.matchedLine).toBe("✖ Timeout after 1200s waiting for rollout");
  });

  it("surfaces an SSH/connectivity readiness failure over a generic terraform echo (build 255)", () => {
    const match = runRules(
      ['            echo "terraform plan failed"', "ERROR: SSH never became ready after 5 minutes"],
      [],
    );
    expect(match.rule.failureType).toBe("INFRA_CONNECTIVITY");
    expect(match.matchedLine).toContain("SSH never became ready");
  });

  it("classifies argo rollout failures as a deploy failure", () => {
    const match = runRules(["rollout degraded: ReplicaSet not progressing"], []);
    expect(match.rule.failureType).toBe("DEPLOY_ROLLOUT_FAILURE");
  });

  it("returns null when nothing matches", () => {
    expect(runRules(["everything is fine"], [])).toBeNull();
  });
});
