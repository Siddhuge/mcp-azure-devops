import { readFileSync } from "node:fs";

/**
 * Portable secret sourcing: for any sensitive variable `X`, if `X_FILE` is set,
 * read the secret from that file and inject it as `process.env.X` (unless `X` is
 * already set, which wins). This is the standard pattern for Kubernetes/Docker
 * secrets, Vault agent, and cloud secret CSI mounts — no vendor SDK needed.
 *
 * Call this BEFORE config validation.
 *
 * @param {string[]} names sensitive env var names to resolve from `*_FILE`
 */
export function loadFileSecrets(names) {
  for (const name of names) {
    const fileVar = `${name}_FILE`;
    const path = process.env[fileVar];
    if (path && !process.env[name]) {
      try {
        process.env[name] = readFileSync(path, "utf8").trim();
      } catch (err) {
        throw new Error(`Failed to read ${fileVar}=${path}: ${err.message}`);
      }
    }
  }
}
