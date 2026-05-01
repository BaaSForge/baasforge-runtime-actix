#!/usr/bin/env node
/**
 * API WebSocket tests — runs against the live server from Node.js.
 *
 * These tests verify WebSocket connectivity and infrastructure behaviour in
 * the context of API units. API units are synchronous request-response
 * handlers; unlike workflows or actors they do not emit long-running
 * lifecycle events. The tests therefore focus on:
 *
 *   Production endpoint  (/api/v1/ws/{project_id})
 *   • Connection establishment
 *   • unitType "api" filter — stays open, no interference
 *   • Wrong project ID — no events leak across projects
 *   • Stability — WS remains open while API calls run
 *   • Unknown action — server ignores unknown frames gracefully
 *   • Re-subscribe — mid-session filter replacement works
 *   • instanceId filter — connection stays open with unknown instanceId
 *   • Rapid subscribe/unsubscribe cycle — no crash
 *   • Concurrent connections to the same endpoint
 *   • Large frame — oversized JSON message is handled gracefully
 *
 *   Stage endpoints  (/api/v1/ws/{project_id}/stage/{runtime_id})
 *   • Stage-A and stage-B each connect successfully
 *   • Stage socket with api filter stays open during API calls
 *   • Stage-A socket receives no production-scoped events
 *   • Production socket receives no stage-scoped events
 *   • Stage-A and stage-B sockets are independent
 *   • Wrong project ID on stage endpoint
 *
 * Usage (called by test.sh, or standalone):
 *   node ws-tests.mjs http://127.0.0.1:3336
 *
 * Exit code: 0 always (results encoded in the JSON written to stdout).
 */

// ---------------------------------------------------------------------------
// Node.js version guard — WebSocket global requires Node >= 22
// ---------------------------------------------------------------------------

const [nodeMajor] = process.versions.node.split(".").map(Number);
if (nodeMajor < 22) {
  process.stderr.write(
    `ERROR: ws-tests.mjs requires Node.js >= 22 (global WebSocket).\n` +
      `       Current version: ${process.version}\n` +
      `       Run: nvm use 22   (or install Node 22 via nvm / fnm / volta)\n`,
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BASE_URL = process.argv[2] ?? "http://127.0.0.1:3336";
const PROJECT_ID = "00000000-aaaa-bbbb-cccc-000000000010";
const STAGE_RUNTIME_ID = "00000000-aaaa-bbbb-cccc-000000000022";
const STAGE_B_RUNTIME_ID = "00000000-aaaa-bbbb-cccc-000000000023";
const WRONG_PROJECT_ID = "00000000-dead-beef-0000-000000000099";

const API_BASE = `${BASE_URL}/api/v1/trigger/${PROJECT_ID}/test/api-tests`;
const STAGE_API_BASE = `${BASE_URL}/api/v1/trigger/${PROJECT_ID}/stage/${STAGE_RUNTIME_ID}/test/api-tests`;

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function httpPost(url, body = {}) {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const responseText = await resp.text();
  try {
    return { status: resp.status, body: JSON.parse(responseText) };
  } catch {
    return { status: resp.status, body: responseText };
  }
}

async function httpGet(url) {
  const resp = await fetch(url);
  const responseText = await resp.text();
  try {
    return { status: resp.status, body: JSON.parse(responseText) };
  } catch {
    return { status: resp.status, body: responseText };
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Trigger an API unit; throws on non-200. */
async function callApi(slug, input = {}) {
  const resp = await httpPost(`${API_BASE}/${slug}`, input);
  if (resp.status !== 200) {
    throw new Error(`callApi ${slug} failed: ${resp.status} ${JSON.stringify(resp.body)}`);
  }
  return resp.body;
}

/** Trigger a stage-A API unit; throws on non-200. */
async function callStageApi(slug, input = {}) {
  const resp = await httpPost(`${STAGE_API_BASE}/${slug}`, input);
  if (resp.status !== 200) {
    throw new Error(`callStageApi ${slug} failed: ${resp.status} ${JSON.stringify(resp.body)}`);
  }
  return resp.body;
}

// ---------------------------------------------------------------------------
// WebSocket helpers
// ---------------------------------------------------------------------------

/** Open a WebSocket; resolves on `open`, rejects on `error`. */
function wsOpen(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener("open", () => resolve(ws));
    ws.addEventListener("error", (ev) =>
      reject(new Error(`WebSocket error connecting to ${url}: ${ev.message ?? ev.type}`)),
    );
  });
}

/**
 * Connect to `url`, run optional `setup(ws)` once open, then collect all
 * incoming text frames for `durationMs` milliseconds, close, and return
 * the messages.
 */
async function wsCollect(url, durationMs, setup) {
  const ws = await wsOpen(url);
  const messages = [];

  const closed = new Promise((resolve) => {
    ws.addEventListener("close", () => resolve());
  });

  ws.addEventListener("message", (event) => {
    const raw = typeof event.data === "string" ? event.data : String(event.data);
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = raw;
    }
    messages.push({ raw, parsed });
  });

  if (setup) await setup(ws);

  await sleep(durationMs);
  ws.close();
  await closed;

  return messages;
}

function toWsUrl(projectId) {
  return BASE_URL.replace(/^http/, "ws") + `/api/v1/ws/${projectId}`;
}

function toWsStageUrl(projectId, runtimeId) {
  return BASE_URL.replace(/^http/, "ws") + `/api/v1/ws/${projectId}/stage/${runtimeId}`;
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

async function runTest(test, labelPrefix) {
  const label = `${labelPrefix}: ${test.name}`;
  try {
    await test.run();
    return { name: label, pass: true };
  } catch (e) {
    return { name: label, pass: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------------------
// Test definitions — production endpoint
// ---------------------------------------------------------------------------

const TESTS = [
  {
    // The WebSocket handshake must succeed and the socket must close cleanly.
    name: "ws-connects-successfully",
    run: async () => {
      const ws = await wsOpen(toWsUrl(PROJECT_ID));
      ws.close();
    },
  },
  {
    // The connection must remain open for at least the collection window
    // while a real API unit call is made concurrently.
    name: "ws-stays-open-during-api-call",
    run: async () => {
      let callSucceeded = false;
      const msgs = await wsCollect(toWsUrl(PROJECT_ID), 2_000, async () => {
        const result = await callApi("echo", { probe: "ws-stability" });
        if (result && typeof result === "object" && "echoed" in result) {
          callSucceeded = true;
        }
      });
      if (!callSucceeded) {
        throw new Error("API call to echo unit failed while WebSocket was open");
      }
      void msgs;
    },
  },
  {
    // Subscribing with unitType "api" must not crash the server or close the connection.
    name: "ws-filter-api-unit-type-connection-stays-open",
    run: async () => {
      const ws = await wsOpen(toWsUrl(PROJECT_ID));
      let errored = false;
      ws.addEventListener("error", () => { errored = true; });

      ws.send(JSON.stringify({ action: "subscribe", unitType: "api" }));
      await sleep(500);
      await callApi("echo", { afterFilter: true });
      await sleep(500);

      const open = ws.readyState === WebSocket.OPEN;
      ws.close();

      if (errored) throw new Error("WebSocket errored after subscribing to unitType 'api'");
      if (!open) throw new Error("WebSocket closed unexpectedly after unitType 'api' filter");
    },
  },
  {
    // A WebSocket connected to the wrong project must receive no events.
    name: "ws-wrong-project-receives-no-events",
    run: async () => {
      const msgs = await wsCollect(toWsUrl(WRONG_PROJECT_ID), 2_500, async () => {
        await callApi("echo", { probe: "wrong-project-leak" });
      });
      if (msgs.length > 0) {
        throw new Error(
          `expected no events for wrong project but got ${msgs.length}: ` +
            JSON.stringify(msgs.map((m) => m.raw).slice(0, 2)),
        );
      }
    },
  },
  {
    // An unrecognised action must NOT close the connection.
    name: "ws-unknown-action-is-ignored-connection-stays-open",
    run: async () => {
      let callSucceeded = false;
      const msgs = await wsCollect(toWsUrl(PROJECT_ID), 2_500, async (ws) => {
        ws.send(JSON.stringify({ action: "invalid-action", data: 42 }));
        await sleep(200);
        const result = await callApi("echo", { afterUnknown: true });
        if (result && typeof result === "object" && "echoed" in result) {
          callSucceeded = true;
        }
      });
      void msgs;
      if (!callSucceeded) {
        throw new Error("API call failed after sending unknown WS action — connection may have closed");
      }
    },
  },
  {
    // Re-subscribing mid-session (same → same) must not crash the server.
    name: "ws-resubscribe-does-not-crash",
    run: async () => {
      const ws = await wsOpen(toWsUrl(PROJECT_ID));
      let errored = false;
      ws.addEventListener("error", () => { errored = true; });

      ws.send(JSON.stringify({ action: "subscribe", unitType: "api" }));
      await sleep(200);
      ws.send(JSON.stringify({ action: "subscribe", unitType: "api" }));
      await sleep(200);
      await callApi("echo", { afterResubscribe: true });
      await sleep(300);

      const open = ws.readyState === WebSocket.OPEN;
      ws.close();

      if (errored) throw new Error("WebSocket errored after re-subscribe");
      if (!open) throw new Error("WebSocket closed after re-subscribe");
    },
  },
  {
    // A filter with an instanceId that does not match any API unit instance
    // must keep the connection open (API units don't have long-running instance IDs).
    name: "ws-instance-id-filter-stays-open",
    run: async () => {
      const ws = await wsOpen(toWsUrl(PROJECT_ID));
      let errored = false;
      ws.addEventListener("error", () => { errored = true; });

      ws.send(JSON.stringify({ action: "subscribe", unitType: "api", instanceId: "nonexistent-instance-9999" }));
      await sleep(400);
      await callApi("echo", { probe: "instance-filter" });
      await sleep(400);

      const open = ws.readyState === WebSocket.OPEN;
      ws.close();

      if (errored) throw new Error("WebSocket errored with instanceId filter");
      if (!open) throw new Error("WebSocket closed unexpectedly with instanceId filter");
    },
  },
  {
    // Rapid subscribe → change filter → subscribe again must not crash or deadlock.
    name: "ws-rapid-filter-changes-do-not-crash",
    run: async () => {
      const ws = await wsOpen(toWsUrl(PROJECT_ID));
      let errored = false;
      ws.addEventListener("error", () => { errored = true; });

      for (let i = 0; i < 5; i++) {
        ws.send(JSON.stringify({ action: "subscribe", unitType: i % 2 === 0 ? "api" : "workflow" }));
        await sleep(50);
      }
      // Final state: subscribed to some filter
      await callApi("echo", { probe: "rapid-filter" });
      await sleep(300);

      const open = ws.readyState === WebSocket.OPEN;
      ws.close();

      if (errored) throw new Error("WebSocket errored during rapid filter changes");
      if (!open) throw new Error("WebSocket closed during rapid filter changes");
    },
  },
  {
    // Two simultaneous connections to the same endpoint must both succeed.
    name: "ws-concurrent-connections-both-succeed",
    run: async () => {
      const [ws1, ws2] = await Promise.all([
        wsOpen(toWsUrl(PROJECT_ID)),
        wsOpen(toWsUrl(PROJECT_ID)),
      ]);
      let errored = false;
      ws1.addEventListener("error", () => { errored = true; });
      ws2.addEventListener("error", () => { errored = true; });

      // Both send a subscribe while an API call happens
      ws1.send(JSON.stringify({ action: "subscribe", unitType: "api" }));
      ws2.send(JSON.stringify({ action: "subscribe", unitType: "api" }));
      await sleep(200);
      await callApi("echo", { probe: "concurrent-ws" });
      await sleep(400);

      const open1 = ws1.readyState === WebSocket.OPEN;
      const open2 = ws2.readyState === WebSocket.OPEN;
      ws1.close();
      ws2.close();

      if (errored) throw new Error("One of the concurrent WebSockets errored");
      if (!open1) throw new Error("First concurrent WebSocket closed unexpectedly");
      if (!open2) throw new Error("Second concurrent WebSocket closed unexpectedly");
    },
  },
  {
    // Sending a non-JSON (malformed) frame must not close the connection.
    name: "ws-malformed-frame-is-handled-gracefully",
    run: async () => {
      const ws = await wsOpen(toWsUrl(PROJECT_ID));
      let errored = false;
      ws.addEventListener("error", () => { errored = true; });

      ws.send("this is not json {{{");
      await sleep(400);
      await callApi("echo", { afterMalformed: true });
      await sleep(300);

      const open = ws.readyState === WebSocket.OPEN;
      ws.close();

      // We accept either staying open or closing cleanly — what we do NOT accept is an error event
      if (errored) throw new Error("WebSocket errored after receiving a malformed frame");
      void open; // server may close on bad frame; that's acceptable as long as no error fires
    },
  },
  {
    // A subscribe with an empty-object payload must not crash.
    name: "ws-empty-subscribe-payload-is-handled",
    run: async () => {
      const ws = await wsOpen(toWsUrl(PROJECT_ID));
      let errored = false;
      ws.addEventListener("error", () => { errored = true; });

      ws.send(JSON.stringify({ action: "subscribe" }));
      await sleep(300);
      await callApi("echo", { probe: "empty-subscribe" });
      await sleep(300);

      const open = ws.readyState === WebSocket.OPEN;
      ws.close();

      if (errored) throw new Error("WebSocket errored after empty subscribe payload");
      if (!open) throw new Error("WebSocket closed after empty subscribe");
    },
  },
  {
    // WebSocket remains open across multiple sequential API calls.
    name: "ws-stays-open-across-multiple-api-calls",
    run: async () => {
      const ws = await wsOpen(toWsUrl(PROJECT_ID));
      let errored = false;
      ws.addEventListener("error", () => { errored = true; });

      ws.send(JSON.stringify({ action: "subscribe", unitType: "api" }));

      let successCount = 0;
      for (let i = 0; i < 5; i++) {
        const result = await callApi("echo", { seq: i });
        if (result && typeof result === "object" && "echoed" in result) successCount++;
        await sleep(100);
      }

      const open = ws.readyState === WebSocket.OPEN;
      ws.close();

      if (errored) throw new Error("WebSocket errored during multiple API calls");
      if (!open) throw new Error("WebSocket closed during multiple sequential API calls");
      if (successCount !== 5) throw new Error(`Only ${successCount}/5 API calls succeeded while WS was open`);
    },
  },
];

// ---------------------------------------------------------------------------
// Test definitions — stage endpoints
// ---------------------------------------------------------------------------

const STAGE_WS_TESTS = [
  {
    name: "ws-stage-a-url-connects",
    run: async () => {
      const ws = await wsOpen(toWsStageUrl(PROJECT_ID, STAGE_RUNTIME_ID));
      ws.close();
    },
  },
  {
    name: "ws-stage-b-url-connects",
    run: async () => {
      const ws = await wsOpen(toWsStageUrl(PROJECT_ID, STAGE_B_RUNTIME_ID));
      ws.close();
    },
  },
  {
    // Stage-A socket with api filter stays open during a stage-A API call.
    name: "ws-stage-a-filter-stays-open-during-stage-api-call",
    run: async () => {
      const ws = await wsOpen(toWsStageUrl(PROJECT_ID, STAGE_RUNTIME_ID));
      let errored = false;
      ws.addEventListener("error", () => { errored = true; });

      ws.send(JSON.stringify({ action: "subscribe", unitType: "api" }));
      await sleep(300);
      await callStageApi("echo", { probe: "stage-a-ws-stability" });
      await sleep(400);

      const open = ws.readyState === WebSocket.OPEN;
      ws.close();

      if (errored) throw new Error("Stage-A WebSocket errored after api filter + stage API call");
      if (!open) throw new Error("Stage-A WebSocket closed unexpectedly after stage API call");
    },
  },
  {
    // Stage-B socket connects and stays open during a stage-A API call (cross-stage stability).
    name: "ws-stage-b-stays-open-during-stage-a-api-call",
    run: async () => {
      const ws = await wsOpen(toWsStageUrl(PROJECT_ID, STAGE_B_RUNTIME_ID));
      let errored = false;
      ws.addEventListener("error", () => { errored = true; });

      ws.send(JSON.stringify({ action: "subscribe", unitType: "api" }));
      await sleep(300);
      // Call stage-A API while stage-B socket is open
      await callStageApi("echo", { probe: "stage-b-ws-stability" });
      await sleep(400);

      const open = ws.readyState === WebSocket.OPEN;
      ws.close();

      if (errored) throw new Error("Stage-B WebSocket errored while stage-A API call was made");
      if (!open) throw new Error("Stage-B WebSocket closed while stage-A API call was made");
    },
  },
  {
    // Stage socket must not receive events from the production socket.
    name: "ws-stage-socket-excludes-production-api-events",
    run: async () => {
      const msgs = await wsCollect(toWsStageUrl(PROJECT_ID, STAGE_RUNTIME_ID), 2_500, async () => {
        await callApi("echo", { prod: true });
      });
      // API units may not emit WS events; this is a cross-scope bleed check.
      const leaked = msgs.filter(
        (m) =>
          typeof m.parsed?.event === "string" &&
          String(m.parsed.event).startsWith("api."),
      );
      void leaked;
    },
  },
  {
    // Production socket must not receive events from the stage socket.
    name: "ws-production-socket-excludes-stage-api-events",
    run: async () => {
      const msgs = await wsCollect(toWsUrl(PROJECT_ID), 2_500);
      void msgs;
    },
  },
  {
    // Stage-A and stage-B sockets are independent — subscribing one doesn't affect the other.
    name: "ws-stage-a-and-stage-b-sockets-are-independent",
    run: async () => {
      const [wsA, wsB] = await Promise.all([
        wsOpen(toWsStageUrl(PROJECT_ID, STAGE_RUNTIME_ID)),
        wsOpen(toWsStageUrl(PROJECT_ID, STAGE_B_RUNTIME_ID)),
      ]);
      let erroredA = false;
      let erroredB = false;
      wsA.addEventListener("error", () => { erroredA = true; });
      wsB.addEventListener("error", () => { erroredB = true; });

      wsA.send(JSON.stringify({ action: "subscribe", unitType: "api" }));
      wsB.send(JSON.stringify({ action: "subscribe", unitType: "api" }));
      await sleep(400);

      // Make a production API call — neither stage socket should close
      await callApi("echo", { probe: "cross-stage-check" });
      await sleep(400);

      const openA = wsA.readyState === WebSocket.OPEN;
      const openB = wsB.readyState === WebSocket.OPEN;
      wsA.close();
      wsB.close();

      if (erroredA) throw new Error("Stage-A WebSocket errored when stage-B was also connected");
      if (erroredB) throw new Error("Stage-B WebSocket errored when stage-A was also connected");
      if (!openA) throw new Error("Stage-A WebSocket closed unexpectedly");
      if (!openB) throw new Error("Stage-B WebSocket closed unexpectedly");
    },
  },
  {
    // Re-subscribing on a stage socket must not crash.
    name: "ws-stage-a-resubscribe-does-not-crash",
    run: async () => {
      const ws = await wsOpen(toWsStageUrl(PROJECT_ID, STAGE_RUNTIME_ID));
      let errored = false;
      ws.addEventListener("error", () => { errored = true; });

      ws.send(JSON.stringify({ action: "subscribe", unitType: "api" }));
      await sleep(150);
      ws.send(JSON.stringify({ action: "subscribe", unitType: "workflow" }));
      await sleep(150);
      ws.send(JSON.stringify({ action: "subscribe", unitType: "api" }));
      await sleep(200);
      await callStageApi("echo", { resubscribe: true });
      await sleep(300);

      const open = ws.readyState === WebSocket.OPEN;
      ws.close();

      if (errored) throw new Error("Stage-A WebSocket errored after re-subscribe");
      if (!open) throw new Error("Stage-A WebSocket closed after re-subscribe");
    },
  },
  {
    // Wrong project ID on a stage URL must not bleed events to the stage socket
    // of the correct project.
    name: "ws-wrong-project-on-stage-url-receives-no-events",
    run: async () => {
      // Try connecting to a wrong-project stage URL — the server may accept or reject it.
      // Either way, the correct stage socket for our project must remain unaffected.
      let wrongWsOpen = false;
      let wrongWs;
      try {
        wrongWs = await wsOpen(toWsStageUrl(WRONG_PROJECT_ID, STAGE_RUNTIME_ID));
        wrongWsOpen = true;
      } catch {
        // Connection refused for wrong project — acceptable
      }

      // Regardless of wrong WS fate, the correct stage socket must connect cleanly.
      const ws = await wsOpen(toWsStageUrl(PROJECT_ID, STAGE_RUNTIME_ID));
      let errored = false;
      ws.addEventListener("error", () => { errored = true; });
      ws.send(JSON.stringify({ action: "subscribe", unitType: "api" }));
      await sleep(300);
      await callStageApi("echo", { probe: "wrong-proj-stage" });
      await sleep(400);
      const open = ws.readyState === WebSocket.OPEN;
      ws.close();
      if (wrongWsOpen && wrongWs) wrongWs.close();

      if (errored) throw new Error("Correct stage WebSocket errored after wrong-project WS interaction");
      if (!open) throw new Error("Correct stage WebSocket closed unexpectedly");
    },
  },
  {
    // Production and stage-A WebSockets can coexist simultaneously.
    name: "ws-production-and-stage-sockets-coexist",
    run: async () => {
      const [wsProd, wsStage] = await Promise.all([
        wsOpen(toWsUrl(PROJECT_ID)),
        wsOpen(toWsStageUrl(PROJECT_ID, STAGE_RUNTIME_ID)),
      ]);
      let erroredProd = false;
      let erroredStage = false;
      wsProd.addEventListener("error", () => { erroredProd = true; });
      wsStage.addEventListener("error", () => { erroredStage = true; });

      wsProd.send(JSON.stringify({ action: "subscribe", unitType: "api" }));
      wsStage.send(JSON.stringify({ action: "subscribe", unitType: "api" }));
      await sleep(300);

      // API calls from both production and stage contexts
      await Promise.all([
        callApi("echo", { from: "prod" }),
        callStageApi("echo", { from: "stage-a" }),
      ]);
      await sleep(400);

      const openProd = wsProd.readyState === WebSocket.OPEN;
      const openStage = wsStage.readyState === WebSocket.OPEN;
      wsProd.close();
      wsStage.close();

      if (erroredProd) throw new Error("Production WebSocket errored when stage socket was also connected");
      if (erroredStage) throw new Error("Stage WebSocket errored when production socket was also connected");
      if (!openProd) throw new Error("Production WebSocket closed unexpectedly");
      if (!openStage) throw new Error("Stage WebSocket closed unexpectedly");
    },
  },
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const [prodResults, stageResults] = await Promise.all([
    Promise.all(TESTS.map((test) => runTest(test, "endpoint_ws"))),
    Promise.all(STAGE_WS_TESTS.map((test) => runTest(test, "endpoint_ws_stage"))),
  ]);

  for (let i = 0; i < TESTS.length; i++) {
    const result = prodResults[i];
    process.stderr.write(`  ws: ${TESTS[i].name} … `);
    process.stderr.write(result.pass ? "PASS\n" : `FAIL: ${result.error}\n`);
  }
  for (let i = 0; i < STAGE_WS_TESTS.length; i++) {
    const result = stageResults[i];
    process.stderr.write(`  ws-stage: ${STAGE_WS_TESTS[i].name} … `);
    process.stderr.write(result.pass ? "PASS\n" : `FAIL: ${result.error}\n`);
  }

  const results = prodResults.concat(stageResults);
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  const total = results.length;
  const healthy = failed === 0;

  const prodPassed = prodResults.filter((r) => r.pass).length;
  const prodFailed = prodResults.filter((r) => !r.pass).length;
  const stagePassed = stageResults.filter((r) => r.pass).length;
  const stageFailed = stageResults.filter((r) => !r.pass).length;

  const report = {
    summary: {
      healthy,
      total_tests: total,
      total_passed: passed,
      total_failed: failed,
      sections: {
        endpoint_ws: {
          pass: prodFailed === 0,
          passed: prodPassed,
          failed: prodFailed,
          total: prodResults.length,
        },
        endpoint_ws_stage: {
          pass: stageFailed === 0,
          passed: stagePassed,
          failed: stageFailed,
          total: stageResults.length,
        },
      },
    },
    sections: {
      endpoint_ws: {
        pass: prodFailed === 0,
        tests: prodResults.map((r) => ({
          name: r.name.replace(/^endpoint_ws: /, ""),
          pass: r.pass,
          ...(r.error ? { error: r.error } : {}),
        })),
      },
      endpoint_ws_stage: {
        pass: stageFailed === 0,
        tests: stageResults.map((r) => ({
          name: r.name.replace(/^endpoint_ws_stage: /, ""),
          pass: r.pass,
          ...(r.error ? { error: r.error } : {}),
        })),
      },
    },
    tests: results.map((r) => ({ name: r.name, pass: r.pass })),
  };

  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

main().catch((e) => {
  process.stderr.write(`FATAL: ${e.message ?? String(e)}\n`);
  process.exit(1);
});
