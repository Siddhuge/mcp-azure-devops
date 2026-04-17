const rules = [
  {
    name: "DOCKER_RATE_LIMIT",
    pattern: /toomanyrequests|pull rate limit/i,
    failureType: "INFRA_DOCKER_RATE_LIMIT",
    severity: "HIGH",
    priority: 100,
    fix: "Authenticate Docker (docker login) or use private registry"
  },
  {
    name: "DOCKER_FAILURE",
    pattern: /docker.*failed|exit code/i,
    failureType: "INFRA_DOCKER_FAILURE",
    severity: "HIGH",
    priority: 90,
    fix: "Check Docker build logs"
  },
  {
    name: "BUILD_FAILURE",
    pattern: /build failed|compilation error/i,
    failureType: "BUILD_FAILURE",
    severity: "HIGH",
    priority: 80,
    fix: "Fix compilation errors"
  },
  {
    name: "CONFIG_DEPRECATED",
    pattern: /obsolete|deprecated/i,
    failureType: "CONFIG_DEPRECATED",
    severity: "LOW",
    priority: 10,
    fix: "Update deprecated config"
  }
];

exports.runRules = (errors = [], warnings = []) => {
  const matches = [];

  for (const rule of rules) {
    for (const line of [...errors, ...warnings]) {
      if (rule.pattern.test(line)) {
        matches.push({
          ...rule,
          matchedLine: line
        });
      }
    }
  }

  
  matches.sort((a, b) => b.priority - a.priority);

  return matches;
};