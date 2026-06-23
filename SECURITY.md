# Security

## Reporting a vulnerability
Please report suspected vulnerabilities privately to the maintainer (open a GitHub
security advisory on `Siddhuge/mcp-azure-devops`). Do not file public issues for
undisclosed vulnerabilities.

## Application security controls
- **AuthN/Z** — bearer auth on all REST/MCP-HTTP routes: named, SHA-256-hashed service
  tokens and/or OIDC/JWT validated against any IdP's JWKS (`iss`/`aud`/`exp` + optional scope).
- **Data egress governance** — secrets/PII (GUIDs, IPs, tokens, emails) are redacted from
  log content before it is sent to the LLM (`LLM_REDACT_INPUT`, default on); the rule-engine
  and cache tiers never call out.
- **Secret handling** — secrets are sourced from files (`*_FILE`) for K8s/Docker/Vault mounts;
  PAT/API key are redacted from logs and error messages; `.env` is gitignored.
- **Hardening** — Helmet headers, CORS locked in prod, per-identity rate limits, bounded
  retries (idempotent-only) and bounded Azure fan-out; container/pod run non-root with a
  read-only root filesystem, dropped capabilities, and a RuntimeDefault seccomp profile.

## Supply chain
- **Reproducible base** — the container base image is pinned by digest in the
  [Dockerfile](Dockerfile) (`node:20-alpine@sha256:…`); bump deliberately.
- **No package manager at runtime** — the bundled `npm` is removed from the runtime image
  (reduces CVE surface); OS packages are patched (`apk upgrade`) at build.
- **Dependency audit** — CI fails on HIGH/CRITICAL in **production** dependencies
  (`npm audit --omit=dev --audit-level=high`); the full audit runs non-blocking. Dev-only
  tooling advisories are not shipped (`npm ci --omit=dev`).
- **Image scan** — CI runs a **Trivy** scan that fails on HIGH/CRITICAL (`--ignore-unfixed`).
- **SBOM** — a CycloneDX SBOM is generated in CI (`sbom.cdx.json`, uploaded as an artifact)
  and locally via `npm run sbom`.

## Operational notes
- Restrict `/metrics` at the network layer or set `METRICS_TOKEN`.
- Rotate any credential that has been exposed (e.g. pasted into a chat/log).
- The audit log (`event:"audit"` JSON lines) records who did what; ship it to your SIEM.
