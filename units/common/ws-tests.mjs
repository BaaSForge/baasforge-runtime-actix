#!/usr/bin/env node
/**
 * Minimal WebSocket infra checks for the common suite (runs in parallel with test.sh).
 *
 * Usage: node ws-tests.mjs http://127.0.0.1:3337
 */

const [nodeMajor] = process.versions.node.split(".").map(Number);
if (nodeMajor < 22) {
  process.stderr.write(`ERROR: Node.js >= 22 required (current: ${process.version})\n`);
  process.exit(1);
}

const BASE_URL = process.argv[2] ?? "http://127.0.0.1:3337";
const PROJECT_ID = "00000000-aaaa-bbbb-cccc-000000000010";
const STAGE_RUNTIME_ID = "00000000-aaaa-bbbb-cccc-000000000022";

const API_HARNESS_BASE = `${BASE_URL}/api/v1/trigger/${PROJECT_ID}/test/common`;
const STAGE_API_HARNESS_BASE = `${BASE_URL}/api/v1/trigger/${PROJECT_ID}/stage/${STAGE_RUNTIME_ID}/test/common`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function wsOpen(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener("open", () => resolve(ws));
    ws.addEventListener("error", (ev) =>
      reject(new Error(`WebSocket error: ${ev.message ?? ev.type}`)),
    );
  });
}

function toWsUrl(projectId) {
  return BASE_URL.replace(/^http/, "ws") + `/api/v1/ws/${projectId}`;
}

function toWsStageUrl(projectId, runtimeId) {
  return BASE_URL.replace(/^http/, "ws") + `/api/v1/ws/${projectId}/stage/${runtimeId}`;
}

async function callApiHarness(slug) {
  const resp = await fetch(`${API_HARNESS_BASE}/${slug}`, { method: "GET" });
  if (resp.status !== 200) {
    throw new Error(`harness ${slug} failed: ${resp.status}`);
  }
}

async function runTest(test, labelPrefix) {
  const label = `${labelPrefix}: ${test.name}`;
  try {
    await test.run();
    return { name: label, pass: true };
  } catch (e) {
    return { name: label, pass: false, error: e instanceof Error ? e.message : String(e) };
  }
}

const PROD_TESTS = [
  {
    name: "ws-connects",
    run: async () => {
      const ws = await wsOpen(toWsUrl(PROJECT_ID));
      ws.close();
    },
  },
  {
    name: "ws-open-during-harness-call",
    run: async () => {
      const ws = await wsOpen(toWsUrl(PROJECT_ID));
      await callApiHarness("ping");
      await sleep(200);
      const open = ws.readyState === WebSocket.OPEN;
      ws.close();
      if (!open) throw new Error("WebSocket closed during harness call");
    },
  },
];

const STAGE_TESTS = [
  {
    name: "ws-stage-a-connects",
    run: async () => {
      const ws = await wsOpen(toWsStageUrl(PROJECT_ID, STAGE_RUNTIME_ID));
      ws.close();
    },
  },
];

async function main() {
  const prodResults = await Promise.all(PROD_TESTS.map((t) => runTest(t, "endpoint_ws")));
  const stageResults = await Promise.all(STAGE_TESTS.map((t) => runTest(t, "endpoint_ws_stage")));
  const results = prodResults.concat(stageResults);

  for (let i = 0; i < PROD_TESTS.length; i++) {
    const r = prodResults[i];
    process.stderr.write(`  ws: ${PROD_TESTS[i].name} … ${r.pass ? "PASS" : `FAIL: ${r.error}`}\n`);
  }
  for (let i = 0; i < STAGE_TESTS.length; i++) {
    const r = stageResults[i];
    process.stderr.write(`  ws-stage: ${STAGE_TESTS[i].name} … ${r.pass ? "PASS" : `FAIL: ${r.error}`}\n`);
  }

  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  const prodPassed = prodResults.filter((r) => r.pass).length;
  const stagePassed = stageResults.filter((r) => r.pass).length;

  const report = {
    summary: {
      healthy: failed === 0,
      total_tests: results.length,
      total_passed: passed,
      total_failed: failed,
      sections: {
        endpoint_ws: { pass: prodPassed === prodResults.length, passed: prodPassed, failed: prodResults.length - prodPassed, total: prodResults.length },
        endpoint_ws_stage: { pass: stagePassed === stageResults.length, passed: stagePassed, failed: stageResults.length - stagePassed, total: stageResults.length },
      },
    },
    sections: {
      endpoint_ws: { pass: prodPassed === prodResults.length, tests: prodResults },
      endpoint_ws_stage: { pass: stagePassed === stageResults.length, tests: stageResults },
    },
    tests: results.map((r) => ({ name: r.name, pass: r.pass })),
  };

  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

main().catch((e) => {
  process.stderr.write(`FATAL: ${e.message ?? String(e)}\n`);
  process.exit(1);
});
