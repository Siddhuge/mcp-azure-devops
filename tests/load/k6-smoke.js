// k6 load + smoke test for the running MCP Azure DevOps server.
//
// Exercises the cheap, deterministic paths (health, projects, rule-engine
// classify) under concurrency — no LLM spend. Thresholds FAIL the run on
// regressions, so this doubles as a gate.
//
// Run against a local container:
//   docker run --rm --network host -e BASE_URL=http://localhost:4000 \
//     -e TOKEN=dev-token-123 -e PROJECT=AzureCanary \
//     -v "$PWD/tests/load:/scripts" grafana/k6 run /scripts/k6-smoke.js
import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Trend } from "k6/metrics";

const BASE = __ENV.BASE_URL || "http://localhost:4000";
const TOKEN = __ENV.TOKEN || "";
const PROJECT = __ENV.PROJECT || "AzureCanary";
const authHeaders = { headers: { Authorization: `Bearer ${TOKEN}` } };

// 429 (rate-limited) is EXPECTED, healthy load-shedding — not an error. We gate
// on the app never returning 5xx and on the latency of *successful* responses.
const serverErrors = new Rate("server_errors_5xx"); // must be ~0
const throttled = new Rate("throttled_429"); // informational
const okLatency = new Trend("ok_latency_ms", true);

export const options = {
  scenarios: {
    load: { executor: "ramping-vus", startVUs: 0, stages: [
      { duration: "10s", target: 10 },
      { duration: "20s", target: 10 },
      { duration: "5s", target: 0 },
    ] },
  },
  thresholds: {
    server_errors_5xx: ["rate<0.001"], // app must not crash/error under load
    "http_req_duration{expected_response:true}": ["p(95)<800"], // fast when served
  },
};

function record(res) {
  serverErrors.add(res.status >= 500);
  throttled.add(res.status === 429);
  if (res.status === 200) okLatency.add(res.timings.duration);
  // Accept 200 (served) or 429 (deliberately throttled); fail only on 5xx/other.
  return check(res, { "200 or 429 (no 5xx)": (r) => r.status === 200 || r.status === 429 });
}

// Resolve a real build id once per VU init (best-effort; falls back gracefully).
let buildId = null;
function ensureBuild() {
  if (buildId !== null) return buildId;
  const r = http.get(`${BASE}/builds?project=${PROJECT}&top=1`, authHeaders);
  try {
    const arr = r.json();
    buildId = Array.isArray(arr) && arr.length ? arr[0].id : 0;
  } catch {
    buildId = 0;
  }
  return buildId;
}

export default function () {
  check(http.get(`${BASE}/healthz`), { "healthz 200": (r) => r.status === 200 });
  record(http.get(`${BASE}/projects`, authHeaders));
  const id = ensureBuild();
  if (id) record(http.get(`${BASE}/logs/${id}/classify?project=${PROJECT}`, authHeaders));
  sleep(0.5);
}
