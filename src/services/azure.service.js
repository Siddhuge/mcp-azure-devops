import axios from "axios";
import { config } from "../config/env.js";
import { logger } from "../config/logger.js";
import { scrubSecrets } from "../config/redact.js";
import {
  AzureAuthError,
  AzureUpstreamError,
  BuildNotFoundError,
  ValidationError,
} from "../utils/errors.js";

const API_VERSION = "7.0";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 300;

const log = logger.child({ module: "azure.service" });

/**
 * Shared axios client, scoped to the **organization** (not a single project) so
 * any project's builds can be reached. Basic auth with an empty username + PAT
 * is the documented Azure DevOps REST scheme. `validateStatus` lets us map
 * status codes to typed errors instead of axios throwing generic ones.
 */
const client = axios.create({
  baseURL: `https://dev.azure.com/${encodeURIComponent(config.azure.org)}`,
  timeout: REQUEST_TIMEOUT_MS,
  auth: { username: "", password: config.azure.pat },
  validateStatus: () => true,
});

/**
 * Resolve the project for a request: the explicit value, else the configured
 * default. Throws if neither is available.
 * @param {string} [project]
 * @returns {string}
 */
function resolveProject(project) {
  const p = (project && String(project).trim()) || config.azure.defaultProject;
  if (!p) {
    throw new ValidationError(
      "A project is required: pass one explicitly or set AZURE_PROJECT as the default.",
    );
  }
  return p;
}

/** Build a project-scoped Build API path. */
function buildPath(project, suffix) {
  return `/${encodeURIComponent(resolveProject(project))}/_apis/build${suffix}`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Retry only transient failures: 429, 5xx, and network errors. */
function isRetryable(status, networkError) {
  if (networkError) return true;
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * Perform a GET with bounded exponential backoff + jitter, honoring Retry-After.
 *
 * @param {string} url
 * @param {import("axios").AxiosRequestConfig} [opts]
 * @returns {Promise<import("axios").AxiosResponse>}
 */
async function getWithRetry(url, opts = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let res;
    try {
      res = await client.get(url, opts);
    } catch (err) {
      // Network/timeout error — no response.
      lastErr = err;
      if (attempt === MAX_RETRIES) {
        throw new AzureUpstreamError("Azure DevOps request failed (network error)", {
          cause: err,
        });
      }
      await backoff(attempt);
      continue;
    }

    if (res.status >= 200 && res.status < 300) return res;

    if (isRetryable(res.status, false) && attempt < MAX_RETRIES) {
      const retryAfter = Number(res.headers?.["retry-after"]);
      await backoff(attempt, Number.isFinite(retryAfter) ? retryAfter * 1000 : undefined);
      continue;
    }

    throw mapStatusError(res, url);
  }
  // Unreachable, but keeps the type checker happy.
  throw new AzureUpstreamError("Azure DevOps request failed", { cause: lastErr });
}

async function backoff(attempt, overrideMs) {
  const expo = BASE_BACKOFF_MS * 2 ** attempt;
  const jitter = Math.random() * BASE_BACKOFF_MS;
  const wait = overrideMs ?? expo + jitter;
  log.debug({ attempt, waitMs: Math.round(wait) }, "retrying Azure request");
  await sleep(wait);
}

function mapStatusError(res, url) {
  const status = res.status;
  if (status === 401 || status === 403) {
    return new AzureAuthError(undefined, { cause: { status, url } });
  }
  if (status === 404) {
    return new BuildNotFoundError("(unknown)", { cause: { status, url } });
  }
  const body = typeof res.data === "string" ? scrubSecrets(res.data).slice(0, 500) : undefined;
  return new AzureUpstreamError(`Azure DevOps returned ${status}`, {
    cause: { status, url, body },
  });
}

/**
 * Azure occasionally returns an HTML sign-in page with a 200 status when the PAT
 * is invalid for a logs endpoint. Detect and convert to a typed auth error.
 */
function assertNotHtml(data) {
  if (typeof data === "string" && /<!DOCTYPE html>|<html/i.test(data.slice(0, 200))) {
    throw new AzureAuthError("Azure returned an HTML page — likely an invalid PAT");
  }
}

/**
 * List log metadata for a build.
 * @param {string|number} buildId
 * @param {string} [project] target project (defaults to AZURE_PROJECT)
 * @returns {Promise<{ count: number, value: Array<{ id: number, lineCount?: number }> }>}
 */
export async function getBuildLogs(buildId, project) {
  const res = await getWithRetry(buildPath(project, `/builds/${encodeURIComponent(buildId)}/logs?api-version=${API_VERSION}`));
  return res.data;
}

/**
 * Fetch a single log's content as an array of lines.
 * @param {string|number} buildId
 * @param {string|number} logId
 * @param {string} [project]
 * @returns {Promise<string[]>}
 */
export async function getLogContent(buildId, logId, project) {
  const res = await getWithRetry(
    buildPath(project, `/builds/${encodeURIComponent(buildId)}/logs/${encodeURIComponent(logId)}?api-version=${API_VERSION}`),
    { headers: { Accept: "text/plain" }, responseType: "text" },
  );
  assertNotHtml(res.data);
  return String(res.data).split("\n");
}

/**
 * Fetch and concatenate all log lines for a build.
 * @param {string|number} buildId
 * @param {string} [project]
 * @returns {Promise<string[]>}
 */
export async function getAllLogLines(buildId, project) {
  const meta = await getBuildLogs(buildId, project);
  const logs = Array.isArray(meta?.value) ? meta.value : [];
  const chunks = await Promise.all(logs.map((l) => getLogContent(buildId, l.id, project)));
  return chunks.flat();
}

/**
 * Fetch error/warning issues from a build's timeline. This is the authoritative
 * source for failures that never reach step logs — agent allocation, unmet
 * demands, stage-level cancellations, etc. Returns empty on 404 (no timeline).
 *
 * @param {string|number} buildId
 * @returns {Promise<{ errors: string[], warnings: string[] }>}
 */
export async function getTimelineIssues(buildId, project) {
  let res;
  try {
    res = await getWithRetry(buildPath(project, `/builds/${encodeURIComponent(buildId)}/timeline?api-version=${API_VERSION}`));
  } catch (err) {
    if (err instanceof BuildNotFoundError) return { errors: [], warnings: [] };
    throw err;
  }
  const records = Array.isArray(res.data?.records) ? res.data.records : [];
  const errors = [];
  const warnings = [];
  for (const record of records) {
    for (const issue of record.issues || []) {
      const msg = String(issue.message || "").trim();
      if (!msg) continue;
      if (issue.type === "error") errors.push(msg);
      else if (issue.type === "warning") warnings.push(msg);
    }
  }
  return { errors, warnings };
}

/**
 * List recent builds in a project (for discovering failing build IDs).
 * @param {{ top?: number, resultFilter?: string, project?: string }} [opts]
 * @returns {Promise<Array<object>>}
 */
export async function listRecentBuilds({ top = 20, resultFilter, project } = {}) {
  const params = new URLSearchParams({ "api-version": API_VERSION, $top: String(top) });
  if (resultFilter) params.set("resultFilter", resultFilter);
  const res = await getWithRetry(buildPath(project, `/builds?${params.toString()}`));
  return Array.isArray(res.data?.value) ? res.data.value : [];
}

/**
 * List all projects in the organization (org-level discovery).
 * @returns {Promise<Array<{ id: string, name: string, state?: string }>>}
 */
export async function listProjects() {
  const res = await getWithRetry(`/_apis/projects?api-version=${API_VERSION}`);
  return Array.isArray(res.data?.value) ? res.data.value : [];
}

/** Lightweight readiness probe — confirms Azure credentials work at org level. */
export async function ping() {
  await listProjects();
  return true;
}
