/**
 * Deterministic, zero-cost failure classification. Rules are matched in priority
 * order (highest first); the first match on any error/warning line wins. Each
 * rule carries its own confidence so the analyzer can decide whether to escalate
 * to the LLM tier.
 *
 * To add a rule: append an object below. Higher `priority` is checked first.
 */

/**
 * @typedef {Object} Rule
 * @property {string} name
 * @property {RegExp} pattern
 * @property {string} failureType
 * @property {"HIGH"|"MEDIUM"|"LOW"} severity
 * @property {number} priority
 * @property {number} confidence  0..1
 * @property {string} fix
 */

/** @type {Rule[]} */
export const rules = [
  {
    name: "DOCKER_RATE_LIMIT",
    pattern: /toomanyrequests|pull rate limit|rate limit.*docker|429 too many requests/i,
    failureType: "INFRA_DOCKER_RATE_LIMIT",
    severity: "HIGH",
    priority: 100,
    confidence: 0.95,
    fix: "Authenticate to Docker Hub (docker login) or pull from a private/mirrored registry.",
  },
  {
    name: "AGENT_POOL",
    // Agent allocation / loss failures surface in the build *timeline*, not step logs.
    pattern:
      /no agent found in pool|satisf(y|ies) the (specified )?demands|no hosted parallelism|all eligible agents|\bAgent\.Version\b|waiting for an? available agent|no agents? (are )?online|stopped hearing from (the )?agent|the agent (machine )?is running|lost communication with the agent/i,
    failureType: "INFRA_AGENT_UNAVAILABLE",
    severity: "HIGH",
    priority: 92,
    confidence: 0.9,
    fix: "No build agent was available or the agent was lost mid-run. Ensure an agent in the target pool is online, healthy, and meets the demands (e.g. Agent.Version); check the agent machine's network/uptime.",
  },
  {
    name: "SSH_AUTH",
    // SSH key/auth failures (recurring in VM-provisioning pipelines).
    pattern:
      /permission denied \(publickey|error in libcrypto|load key .*: (error|invalid format)|host key verification failed|too many authentication failures|ssh:.*(authentication|permission denied)|no supported authentication methods/i,
    failureType: "SSH_AUTH_FAILURE",
    severity: "HIGH",
    priority: 84,
    confidence: 0.85,
    fix: "SSH authentication failed — usually a missing/corrupt private key or wrong user. Verify the key loads cleanly (no libcrypto error), the correct key/user is used, and the public key is in the target's authorized_keys.",
  },
  {
    name: "K8S_IMAGE_PULL",
    pattern: /imagepullbackoff|errimagepull|failed to pull image|manifest unknown/i,
    failureType: "INFRA_IMAGE_PULL",
    severity: "HIGH",
    priority: 95,
    confidence: 0.9,
    fix: "Verify the image name/tag exists and the cluster has registry pull credentials.",
  },
  {
    name: "OOM_KILLED",
    pattern: /oomkilled|out of memory|cannot allocate memory|killed process/i,
    failureType: "INFRA_OOM",
    severity: "HIGH",
    priority: 90,
    confidence: 0.9,
    fix: "Increase the container/agent memory limit or reduce the build's memory footprint.",
  },
  {
    name: "FS_PERMISSION",
    // Filesystem/privilege errors — must out-rank AUTH so a `Permission denied`
    // on a file path isn't mislabeled as a credential failure.
    pattern:
      /\beacces\b|operation not permitted|(cannot (remove|create|open|write|access|stat|mkdir|touch)\b.*permission denied)|(mkdir|touch|cp|mv|rm|install):.*permission denied|read-only file system/i,
    failureType: "FS_PERMISSION",
    severity: "HIGH",
    priority: 86,
    confidence: 0.8,
    fix: "A step lacks filesystem/privilege access. Install tools to a writable path (e.g. $HOME/.local/bin or the agent tool cache), run the step with sufficient privileges (sudo), or fix ownership on the target path.",
  },
  {
    name: "AUTH_CREDENTIAL",
    // Credential/identity denials only — `permission denied` is handled by FS_PERMISSION first.
    pattern: /unauthorized|forbidden|\b401\b|\b403\b|invalid credentials|authentication failed|access denied|not authorized/i,
    failureType: "AUTH_FAILURE",
    severity: "HIGH",
    priority: 85,
    confidence: 0.8,
    fix: "Check service connection / token scopes and that secrets are available to the pipeline.",
  },
  {
    name: "NPM_INSTALL",
    pattern: /npm err!|yarn error|pnpm.*err|eresolve|peer dep|404 not found.*npm/i,
    failureType: "BUILD_DEPENDENCY",
    severity: "HIGH",
    priority: 80,
    confidence: 0.85,
    fix: "Resolve dependency conflicts; check the registry, lockfile, and network access.",
  },
  {
    name: "TEST_FAILURE",
    pattern: /tests? failed|assertion(error| failed)|\d+ failing|test run failed|expect\(.*\)/i,
    failureType: "TEST_FAILURE",
    severity: "MEDIUM",
    priority: 75,
    confidence: 0.8,
    fix: "Inspect the failing test output and fix the assertion or the code under test.",
  },
  {
    name: "COMPILE_ERROR",
    pattern: /compilation (error|failed)|cannot find symbol|syntaxerror|type error|ts\d{3,}:|\bCS\d{3,}\b/i,
    failureType: "BUILD_COMPILE",
    severity: "HIGH",
    priority: 70,
    confidence: 0.85,
    fix: "Fix the compilation/type error reported in the log.",
  },
  {
    name: "CONNECTIVITY",
    // Host/endpoint never became reachable — surfaces above a generic IaC echo
    // because it's the concrete, actionable cause (e.g. VM/SSH never came up).
    pattern:
      /ssh never became ready|never became ready|connection refused|could not connect|couldn'?t connect|host unreachable|no route to host|connection reset|connection timed out|i\/o timeout|dial tcp/i,
    failureType: "INFRA_CONNECTIVITY",
    severity: "HIGH",
    priority: 68,
    confidence: 0.78,
    fix: "A host/endpoint never became reachable. Check the target's startup/health, network/NSG/firewall and DNS, and the port (e.g. SSH 22); increase the readiness wait if the host is slow to boot.",
  },
  {
    name: "TERRAFORM",
    pattern: /terraform.*(error|failed)|error: .* terraform|plan\/apply failed/i,
    failureType: "IAC_TERRAFORM",
    severity: "HIGH",
    priority: 65,
    confidence: 0.75,
    fix: "Review the Terraform error — often state lock, provider auth, or invalid resource config.",
  },
  {
    name: "TIMEOUT",
    // Word boundaries keep this from matching schema keywords like `timeoutInMinutes`.
    pattern: /\btimed out\b|\btimeout\b(?!inminutes)|timeout after \d|deadline exceeded|operation was canceled\b/i,
    failureType: "INFRA_TIMEOUT",
    severity: "MEDIUM",
    priority: 60,
    confidence: 0.7,
    fix: "Increase the timeout or investigate the slow/hanging step or upstream dependency.",
  },
  {
    name: "DEPLOY_ROLLOUT",
    pattern: /rollout (failed|degraded|aborted)|argo rollouts?.*(failed|error)|deployment.*(failed|did not become ready)|readiness probe failed/i,
    failureType: "DEPLOY_ROLLOUT_FAILURE",
    severity: "HIGH",
    priority: 62,
    confidence: 0.75,
    fix: "Inspect the rollout/deployment status and pod events (kubectl describe / argo rollouts get).",
  },
  {
    name: "DOCKER_BUILD",
    pattern: /docker.*(build|push).*(failed|error)|failed to solve|dockerfile.*error|non-zero code/i,
    failureType: "INFRA_DOCKER_BUILD",
    severity: "HIGH",
    priority: 55,
    confidence: 0.7,
    fix: "Check the Docker build context, the failing Dockerfile instruction, and the exit code.",
  },
  {
    name: "GENERIC_NONZERO_EXIT",
    pattern: /exited with code [1-9]|process completed with exit code [1-9]|##\[error\]/i,
    failureType: "BUILD_FAILURE",
    severity: "MEDIUM",
    priority: 30,
    confidence: 0.55,
    fix: "A step exited non-zero — inspect the surrounding log lines for the root cause.",
  },
  {
    name: "CONFIG_DEPRECATED",
    pattern: /deprecated|obsolete|will be removed/i,
    failureType: "CONFIG_DEPRECATED",
    severity: "LOW",
    priority: 10,
    confidence: 0.5,
    fix: "Update the deprecated configuration/API before it is removed.",
  },
];

const sortedRules = [...rules].sort((a, b) => b.priority - a.priority);

/**
 * Score how strongly a line reads as an actual failure (vs. a script echo or a
 * variable declaration that merely mentions the keyword). Used to pick the most
 * representative line among several that match the same rule.
 * @param {string} line
 * @returns {number}
 */
function failureScore(line) {
  let score = 0;
  if (/##\[error\]/i.test(line)) score += 3;
  if (/[✖✗]|\berror:|\bfatal\b/i.test(line)) score += 2;
  if (/\b(failed|failure|exception|exited with code)\b/i.test(line)) score += 1;
  // Demote shell variable assignments / comments that just contain the keyword
  // (e.g. `TIMEOUT=1200   # 20 minutes`).
  if (/^\s*[A-Z_]+=/.test(line) || /^\s*#/.test(line)) score -= 2;
  // Demote script *source* lines (an `echo` statement or an unexpanded `${VAR}`)
  // in favor of the actual runtime output of that command.
  if (/\becho\b/.test(line) || /\$\{/.test(line)) score -= 2;
  return score;
}

/**
 * Run the rule engine over filtered error/warning lines.
 *
 * Rules are checked in priority order; the highest-priority rule that matches
 * any line wins. Among the lines that rule matches, the most failure-like line
 * is chosen as the reported root cause.
 *
 * @param {string[]} [errors]
 * @param {string[]} [warnings]
 * @returns {{ rule: Rule, matchedLine: string } | null}
 */
export function runRules(errors = [], warnings = []) {
  const lines = [...errors, ...warnings];
  for (const rule of sortedRules) {
    const matches = lines.filter((line) => rule.pattern.test(line));
    if (matches.length === 0) continue;
    // Prefer the most failure-like matching line; ties keep original order.
    let best = matches[0];
    let bestScore = failureScore(best);
    for (const line of matches.slice(1)) {
      const s = failureScore(line);
      if (s > bestScore) {
        best = line;
        bestScore = s;
      }
    }
    return { rule, matchedLine: best };
  }
  return null;
}
