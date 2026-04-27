#!/usr/bin/env node
/**
 * Queue Worker WebSocket tests — runs against the live server from Node.js.
 *
 * Covers GET /api/v1/ws/{project_id} with queue-worker subscriptions:
 *   • Lifecycle events  → qw.events.{pid}.queue-worker.{run_id}
 *   • unitType filter   → unitType: "queue-worker"
 *   • instanceId filter → instanceId: "<runId>"
 *   • Re-subscribe      → replaces the NATS subject mid-session
 *   • Unfiltered        → wf.events.{pid}.> + qw.events.{pid}.>
 *
 * Usage (called by test.sh, or standalone):
 *   node ws-tests.mjs http://127.0.0.1:3335
 *
 * Exit code: 0 always (results encoded in the JSON written to stdout).
 */

const [nodeMajor] = process.versions.node.split(".").map(Number);
if (nodeMajor < 22) {
  process.stderr.write(
    `ERROR: ws-tests.mjs requires Node.js >= 22 (global WebSocket).\n` +
      `       Current version: ${process.version}\n` +
      `       Run: nvm use 22\n`,
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BASE_URL = process.argv[2] ?? "http://127.0.0.1:3335";
const PROJECT_ID = "00000000-aaaa-bbbb-cccc-000000000010";
const ALT_PROJECT_ID = "00000000-aaaa-bbbb-cccc-000000000012";
const STAGE_RUNTIME_ID = "00000000-aaaa-bbbb-cccc-000000000022";
const STAGE_B_RUNTIME_ID = "00000000-aaaa-bbbb-cccc-000000000023";

const QW_BASE = `${BASE_URL}/api/v1/trigger/workerQueue/${PROJECT_ID}/test/queue-worker`;

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function httpPost(url, body = {}) {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  try {
    return { status: resp.status, body: JSON.parse(text) };
  } catch {
    return { status: resp.status, body: text };
  }
}

async function httpGet(url) {
  const resp = await fetch(url);
  const text = await resp.text();
  try {
    return { status: resp.status, body: JSON.parse(text) };
  } catch {
    return { status: resp.status, body: text };
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Queue Worker HTTP helpers
// ---------------------------------------------------------------------------

function qwUrl(slug) {
  return `${QW_BASE}/${slug}`;
}

function qwRunUrl(slug, runId, suffix) {
  return `${qwUrl(slug)}/${runId}/${suffix}`;
}

function qwStageUrl(slug, runtimeId = STAGE_RUNTIME_ID) {
  return `${BASE_URL}/api/v1/trigger/workerQueue/${PROJECT_ID}/stage/${runtimeId}/test/queue-worker/${slug}`;
}

async function enqueueWorker(slug, data = {}) {
  const resp = await httpPost(qwUrl(slug), data);
  if (resp.status !== 200 || !resp.body?.runId) {
    throw new Error(`enqueue ${slug} failed: ${resp.status} ${JSON.stringify(resp.body)}`);
  }
  return { runId: resp.body.runId, status: resp.body.status };
}

async function enqueueStageWorker(slug, data = {}, runtimeId = STAGE_RUNTIME_ID) {
  const resp = await httpPost(qwStageUrl(slug, runtimeId), data);
  if (resp.status !== 200 || !resp.body?.runId) {
    throw new Error(`stage enqueue ${slug} failed: ${resp.status} ${JSON.stringify(resp.body)}`);
  }
  return { runId: resp.body.runId, status: resp.body.status };
}

async function getWorkerStatus(slug, runId) {
  const resp = await httpGet(qwRunUrl(slug, runId, "status"));
  const s = resp.body?.status ?? resp.body?.meta?.status ?? "unknown";
  return s;
}

async function cancelRun(slug, runId) {
  return httpPost(qwRunUrl(slug, runId, "cancel"));
}

async function pollUntil(slug, runId, target, maxIter = 200) {
  const seen = new Set();
  for (let i = 0; i < maxIter; i++) {
    await sleep(150);
    const st = await getWorkerStatus(slug, runId);
    seen.add(st);
    if (st === target) return st;
    if (
      st === "dead_letter" ||
      st === "cancelled" ||
      (target !== "completed" && st === "completed")
    ) {
      throw new Error(`reached terminal state '${st}' while waiting for '${target}'`);
    }
  }
  throw new Error(`timed out waiting for '${target}' (saw: ${[...seen].join(", ")})`);
}

async function pollUntilTerminal(slug, runId, maxIter = 200) {
  const terminal = new Set(["completed", "dead_letter", "cancelled"]);
  for (let i = 0; i < maxIter; i++) {
    await sleep(150);
    const st = await getWorkerStatus(slug, runId);
    if (terminal.has(st)) return st;
  }
  throw new Error(`timed out waiting for terminal status`);
}

// ---------------------------------------------------------------------------
// WebSocket helpers
// ---------------------------------------------------------------------------

function toWsUrl(projectId) {
  return BASE_URL.replace(/^http/, "ws") + `/api/v1/ws/${projectId}`;
}

function toWsStageUrl(projectId, runtimeId) {
  return BASE_URL.replace(/^http/, "ws") + `/api/v1/ws/${projectId}/stage/${runtimeId}`;
}

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
 * Open a WS, run setup(ws), collect messages for durationMs, close, return messages.
 */
async function wsCollect(url, durationMs, setup) {
  const ws = await wsOpen(url);
  const messages = [];

  const closed = new Promise((resolve) => ws.addEventListener("close", () => resolve()));

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

  try {
    if (setup) await setup(ws);
    await sleep(durationMs);
  } finally {
    ws.close();
    await closed;
  }

  return messages;
}

function wsEvents(msgs) {
  return msgs
    .map((m) => (m.parsed && typeof m.parsed === "object" ? m.parsed.event : null))
    .filter((e) => typeof e === "string");
}

function wsRunIds(msgs) {
  return msgs
    .map((m) => (m.parsed && typeof m.parsed === "object" ? m.parsed.runId : null))
    .filter((id) => typeof id === "string");
}

function checkSubsequence(events, sequence) {
  let idx = 0;
  for (const ev of events) {
    if (ev === sequence[idx]) idx++;
    if (idx === sequence.length) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

async function runTest(sectionLabel, test) {
  const label = `${sectionLabel}: ${test.name}`;
  if (test.skip) {
    return { name: label, pass: true, skipped: true, detail: `SKIPPED: ${test.skip}` };
  }
  try {
    await test.run();
    return { name: label, pass: true };
  } catch (e) {
    return { name: label, pass: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------------------
// ws_lifecycle tests (7)
// ---------------------------------------------------------------------------

const WS_LIFECYCLE = [
  {
    name: "ws-queued-event",
    run: async () => {
      let runId;
      const msgs = await wsCollect(toWsUrl(PROJECT_ID), 4_000, async (ws) => {
        ws.send(JSON.stringify({ action: "subscribe", unitType: "queue-worker" }));
        await sleep(100);
        const enqueued = await enqueueWorker("echo-worker", { v: 1 });
        runId = enqueued.runId;
      });
      const events = wsEvents(msgs);
      const forRun = msgs.filter((m) => m.parsed?.runId === runId);
      if (forRun.length === 0)
        throw new Error(`no events for runId ${runId}; got events: ${JSON.stringify(events)}`);
      if (!wsEvents(forRun).includes("queueWorker.queued"))
        throw new Error(`missing queueWorker.queued; got: ${JSON.stringify(wsEvents(forRun))}`);
      const queuedMsg = forRun.find((m) => m.parsed?.event === "queueWorker.queued");
      if (!queuedMsg?.parsed?.runId)
        throw new Error(`queueWorker.queued missing runId field`);
      if (!queuedMsg.parsed?.workerPath)
        throw new Error(`queueWorker.queued missing workerPath field`);
    },
  },
  {
    name: "ws-processing-event",
    run: async () => {
      let runId;
      const msgs = await wsCollect(toWsUrl(PROJECT_ID), 5_000, async (ws) => {
        ws.send(JSON.stringify({ action: "subscribe", unitType: "queue-worker" }));
        await sleep(100);
        const enqueued = await enqueueWorker("slow-worker", { sleepMs: 3000 });
        runId = enqueued.runId;
      });
      const forRun = msgs.filter((m) => m.parsed?.runId === runId);
      const events = wsEvents(forRun);
      if (!events.includes("queueWorker.processing"))
        throw new Error(`missing queueWorker.processing; got: ${JSON.stringify(events)}`);
      const procMsg = forRun.find((m) => m.parsed?.event === "queueWorker.processing");
      if (procMsg?.parsed?.attempt !== 1)
        throw new Error(`expected attempt: 1 on processing event, got: ${procMsg?.parsed?.attempt}`);
    },
  },
  {
    name: "ws-completed-event",
    run: async () => {
      let runId;
      const msgs = await wsCollect(toWsUrl(PROJECT_ID), 5_000, async (ws) => {
        ws.send(JSON.stringify({ action: "subscribe", unitType: "queue-worker" }));
        await sleep(100);
        const enqueued = await enqueueWorker("echo-worker", { v: 2 });
        runId = enqueued.runId;
      });
      const forRun = msgs.filter((m) => m.parsed?.runId === runId);
      const events = wsEvents(forRun);
      if (!events.includes("queueWorker.completed"))
        throw new Error(`missing queueWorker.completed; got: ${JSON.stringify(events)}`);
      const completedMsg = forRun.find((m) => m.parsed?.event === "queueWorker.completed");
      if (!("result" in (completedMsg?.parsed ?? {})))
        throw new Error(`queueWorker.completed missing result field`);
    },
  },
  {
    name: "ws-failed-event",
    run: async () => {
      let runId;
      const msgs = await wsCollect(toWsUrl(PROJECT_ID), 8_000, async (ws) => {
        ws.send(JSON.stringify({ action: "subscribe", unitType: "queue-worker" }));
        await sleep(100);
        const enqueued = await enqueueWorker("fail-twice-worker", {});
        runId = enqueued.runId;
      });
      const forRun = msgs.filter((m) => m.parsed?.runId === runId);
      const events = wsEvents(forRun);
      if (!events.includes("queueWorker.failed"))
        throw new Error(`missing queueWorker.failed; got: ${JSON.stringify(events)}`);
      const failedMsg = forRun.find((m) => m.parsed?.event === "queueWorker.failed");
      if (!failedMsg?.parsed?.error)
        throw new Error(`queueWorker.failed missing error field`);
      if (typeof failedMsg.parsed?.attempt !== "number")
        throw new Error(`queueWorker.failed missing attempt field`);
    },
  },
  {
    name: "ws-retrying-event",
    run: async () => {
      let runId;
      const msgs = await wsCollect(toWsUrl(PROJECT_ID), 15_000, async (ws) => {
        ws.send(JSON.stringify({ action: "subscribe", unitType: "queue-worker" }));
        await sleep(100);
        const enqueued = await enqueueWorker("fail-twice-worker", {});
        runId = enqueued.runId;
      });
      const forRun = msgs.filter((m) => m.parsed?.runId === runId);
      const events = wsEvents(forRun);
      if (!events.includes("queueWorker.retrying"))
        throw new Error(`missing queueWorker.retrying; got: ${JSON.stringify(events)}`);
      const retryingMsg = forRun.find((m) => m.parsed?.event === "queueWorker.retrying");
      if (typeof retryingMsg?.parsed?.attempt !== "number")
        throw new Error(`queueWorker.retrying missing attempt field`);
    },
  },
  {
    name: "ws-dead-letter-event",
    run: async () => {
      let runId;
      const msgs = await wsCollect(toWsUrl(PROJECT_ID), 30_000, async (ws) => {
        ws.send(JSON.stringify({ action: "subscribe", unitType: "queue-worker" }));
        await sleep(100);
        const enqueued = await enqueueWorker("always-fail-worker", {});
        runId = enqueued.runId;
      });
      const forRun = msgs.filter((m) => m.parsed?.runId === runId);
      const events = wsEvents(forRun);
      if (!events.includes("queueWorker.dead_letter"))
        throw new Error(`missing queueWorker.dead_letter; got: ${JSON.stringify(events)}`);
      const dlMsg = forRun.find((m) => m.parsed?.event === "queueWorker.dead_letter");
      if (!dlMsg?.parsed?.error)
        throw new Error(`queueWorker.dead_letter missing error field`);
    },
  },
  {
    name: "ws-cancelled-event",
    run: async () => {
      const { runId } = await enqueueWorker("slow-worker", { sleepMs: 10_000 });
      let receivedCancelled = false;

      const msgs = await wsCollect(toWsUrl(PROJECT_ID), 5_000, async (ws) => {
        ws.send(
          JSON.stringify({ action: "subscribe", unitType: "queue-worker", instanceId: runId }),
        );
        await sleep(300);
        await cancelRun("slow-worker", runId);
      });

      const forRun = msgs.filter((m) => m.parsed?.runId === runId);
      receivedCancelled = wsEvents(forRun).includes("queueWorker.cancelled");
      if (!receivedCancelled)
        throw new Error(
          `missing queueWorker.cancelled; got: ${JSON.stringify(wsEvents(forRun))}`,
        );
    },
  },
];

// ---------------------------------------------------------------------------
// ws_filtering tests (4)
// ---------------------------------------------------------------------------

const WS_FILTERING = [
  {
    // Subscribe with unitType: "queue-worker". Enqueue a worker and verify:
    //   - queueWorker.* events arrive
    //   - no workflow.* events arrive (the filter is respected)
    name: "ws-filter-queue-worker-only",
    run: async () => {
      let runId;
      const msgs = await wsCollect(toWsUrl(PROJECT_ID), 4_000, async (ws) => {
        ws.send(JSON.stringify({ action: "subscribe", unitType: "queue-worker" }));
        await sleep(100);
        const enqueued = await enqueueWorker("echo-worker", { filter: 1 });
        runId = enqueued.runId;
      });
      const events = wsEvents(msgs);
      const wfEvents = events.filter((e) => e.startsWith("workflow."));
      if (wfEvents.length > 0)
        throw new Error(
          `got workflow.* events on a queue-worker-only subscription: ${JSON.stringify(wfEvents)}`,
        );
      const qwEvents = msgs.filter((m) => m.parsed?.runId === runId);
      if (qwEvents.length === 0)
        throw new Error(`expected queueWorker.* events but got none; all events: ${JSON.stringify(events)}`);
    },
  },
  {
    name: "ws-filter-specific-run",
    run: async () => {
      const { runId: slowRunId } = await enqueueWorker("slow-worker", {
        sleepMs: 6_000,
      });

      let fastRunId;
      const msgs = await wsCollect(toWsUrl(PROJECT_ID), 7_000, async (ws) => {
        ws.send(
          JSON.stringify({
            action: "subscribe",
            unitType: "queue-worker",
            instanceId: slowRunId,
          }),
        );
        await sleep(300);
        const enqueued = await enqueueWorker("echo-worker", { filter: 2 });
        fastRunId = enqueued.runId;
      });

      const forSlow = msgs.filter((m) => m.parsed?.runId === slowRunId);
      const forFast = msgs.filter((m) => m.parsed?.runId === fastRunId);

      if (forSlow.length === 0)
        throw new Error(`expected events for slow run (${slowRunId}) but got none`);
      if (forFast.length > 0)
        throw new Error(
          `expected no events for fast run (${fastRunId}) but got ${forFast.length}: ` +
            JSON.stringify(forFast.map((m) => m.raw)),
        );
    },
  },
  {
    // No subscribe message → default broad subscription (qw.events.{pid}.>).
    // Enqueue two different workers; both runs' events must arrive on the same WS.
    name: "ws-unfiltered-receives-all",
    run: async () => {
      let runIdA;
      let runIdB;
      const msgs = await wsCollect(toWsUrl(PROJECT_ID), 5_000, async () => {
        const [a, b] = await Promise.all([
          enqueueWorker("echo-worker", { unfiltered: "a" }),
          enqueueWorker("process-and-return", { value: 1, label: "unfiltered-b" }),
        ]);
        runIdA = a.runId;
        runIdB = b.runId;
      });

      const forA = msgs.filter((m) => m.parsed?.runId === runIdA);
      const forB = msgs.filter((m) => m.parsed?.runId === runIdB);

      if (forA.length === 0)
        throw new Error(`expected events for run A (${runIdA}) but got none`);
      if (forB.length === 0)
        throw new Error(`expected events for run B (${runIdB}) but got none`);
    },
  },
  {
    name: "ws-resubscribe-narrows-filter",
    run: async () => {
      // Pre-position a slow run to get its runId before subscribing.
      const { runId: targetRunId } = await enqueueWorker("slow-worker", {
        sleepMs: 8_000,
      });

      let otherRunId;
      const msgs = await wsCollect(toWsUrl(PROJECT_ID), 9_000, async (ws) => {
        // Start broad — receives all QW events for this project.
        // (no subscribe message = default broad subscription)
        await sleep(100);
        // Narrow to target run.
        ws.send(
          JSON.stringify({
            action: "subscribe",
            unitType: "queue-worker",
            instanceId: targetRunId,
          }),
        );
        // Wait for server to re-subscribe on NATS.
        await sleep(500);
        // Start another fast run after narrowing — its events must not leak through.
        const enqueued = await enqueueWorker("echo-worker", { resubscribe: 1 });
        otherRunId = enqueued.runId;
      });

      const forTarget = msgs.filter((m) => m.parsed?.runId === targetRunId);
      const forOther = msgs.filter((m) => m.parsed?.runId === otherRunId);

      if (forTarget.length === 0)
        throw new Error(`expected events for target run after re-subscribe; got none`);
      if (forOther.length > 0)
        throw new Error(
          `expected no events for other run after narrowing; got ${forOther.length}`,
        );
    },
  },
  {
    name: "ws-wrong-project-receives-no-queue-worker-events",
    run: async () => {
      const msgs = await wsCollect(toWsUrl(ALT_PROJECT_ID), 3_500, async (ws) => {
        ws.send(JSON.stringify({ action: "subscribe", unitType: "queue-worker" }));
        await sleep(200);
        await enqueueWorker("echo-worker", { wsWrongProj: 1 });
      });
      if (msgs.length > 0) {
        throw new Error(
          `expected no QW events on wrong-project WebSocket, got ${msgs.length}: ` +
            JSON.stringify(msgs.slice(0, 2).map((m) => m.raw)),
        );
      }
    },
  },
];

// ---------------------------------------------------------------------------
// ws_edge_cases tests (5)
// ---------------------------------------------------------------------------

const WS_EDGE_CASES = [
  {
    name: "ws-event-ordering",
    run: async () => {
      let runId;
      const msgs = await wsCollect(toWsUrl(PROJECT_ID), 5_000, async (ws) => {
        ws.send(JSON.stringify({ action: "subscribe", unitType: "queue-worker" }));
        await sleep(100);
        const enqueued = await enqueueWorker("echo-worker", { order: 1 });
        runId = enqueued.runId;
        // Wait briefly so the queued event arrives before narrowing the subscription.
        await sleep(300);
        ws.send(
          JSON.stringify({ action: "subscribe", unitType: "queue-worker", instanceId: runId }),
        );
      });

      const events = wsEvents(msgs.filter((m) => m.parsed?.runId === runId));
      if (events.length < 2)
        throw new Error(`expected at least queued+completed events; got: ${JSON.stringify(events)}`);

      const queuedIdx = events.indexOf("queueWorker.queued");
      const processingIdx = events.indexOf("queueWorker.processing");
      const completedIdx = events.indexOf("queueWorker.completed");

      if (queuedIdx === -1) throw new Error(`missing queueWorker.queued`);
      if (processingIdx === -1) throw new Error(`missing queueWorker.processing`);
      if (completedIdx === -1) throw new Error(`missing queueWorker.completed`);

      if (queuedIdx > processingIdx)
        throw new Error(`queued arrived after processing (idx ${queuedIdx} > ${processingIdx})`);
      if (processingIdx > completedIdx)
        throw new Error(`processing arrived after completed (idx ${processingIdx} > ${completedIdx})`);
    },
  },
  {
    name: "ws-event-ordering-with-retry",
    run: async () => {
      let runId;
      const msgs = await wsCollect(toWsUrl(PROJECT_ID), 30_000, async (ws) => {
        ws.send(JSON.stringify({ action: "subscribe", unitType: "queue-worker" }));
        await sleep(100);
        const enqueued = await enqueueWorker("fail-twice-worker", {});
        runId = enqueued.runId;
        // Wait briefly so the queued event arrives before narrowing the subscription.
        await sleep(300);
        ws.send(
          JSON.stringify({ action: "subscribe", unitType: "queue-worker", instanceId: runId }),
        );
      });

      const events = wsEvents(msgs.filter((m) => m.parsed?.runId === runId));

      // Verify the full lifecycle sequence is a subsequence of received events.
      const expectedSequence = [
        "queueWorker.queued",
        "queueWorker.processing",
        "queueWorker.failed",
        "queueWorker.retrying",
        "queueWorker.processing",
        "queueWorker.failed",
        "queueWorker.retrying",
        "queueWorker.processing",
        "queueWorker.completed",
      ];
      if (!checkSubsequence(events, expectedSequence))
        throw new Error(
          `full retry sequence not found; got: ${JSON.stringify(events)}\n` +
            `expected subsequence: ${JSON.stringify(expectedSequence)}`,
        );
    },
  },
  {
    name: "ws-multiple-clients-same-project",
    run: async () => {
      const ws1 = await wsOpen(toWsUrl(PROJECT_ID));
      const ws2 = await wsOpen(toWsUrl(PROJECT_ID));

      const msgs1 = [];
      const msgs2 = [];

      const toEntry = (raw) => {
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = raw;
        }
        return { raw, parsed };
      };

      ws1.addEventListener("message", (ev) => msgs1.push(toEntry(String(ev.data))));
      ws2.addEventListener("message", (ev) => msgs2.push(toEntry(String(ev.data))));

      try {
        const sub = JSON.stringify({ action: "subscribe", unitType: "queue-worker" });
        ws1.send(sub);
        ws2.send(sub);

        await sleep(200);
        const { runId } = await enqueueWorker("echo-worker", { multi: 1 });
        await sleep(4_000);

        const events1 = wsEvents(msgs1.filter((m) => m.parsed?.runId === runId));
        const events2 = wsEvents(msgs2.filter((m) => m.parsed?.runId === runId));

        if (!events1.includes("queueWorker.completed"))
          throw new Error(`client 1 missing queueWorker.completed; got: ${JSON.stringify(events1)}`);
        if (!events2.includes("queueWorker.completed"))
          throw new Error(`client 2 missing queueWorker.completed; got: ${JSON.stringify(events2)}`);
      } finally {
        ws1.close();
        ws2.close();
      }
    },
  },
  {
    name: "ws-late-connect",
    run: async () => {
      const { runId } = await enqueueWorker("echo-worker", { late: 1 });
      await pollUntilTerminal("echo-worker", runId);

      // Connect AFTER completion — no events should arrive for this run.
      const msgs = await wsCollect(toWsUrl(PROJECT_ID), 2_000, async (ws) => {
        ws.send(JSON.stringify({ action: "subscribe", unitType: "queue-worker" }));
      });

      const forRun = msgs.filter((m) => m.parsed?.runId === runId);
      if (forRun.length > 0)
        throw new Error(
          `expected no events for already-completed run, got ${forRun.length} stale events`,
        );
    },
  },
  {
    name: "ws-disconnect-reconnect",
    run: async () => {
      // Phase 1: connect, enqueue A, wait for completion, disconnect.
      let runIdA;
      const phase1 = await wsCollect(toWsUrl(PROJECT_ID), 5_000, async (ws) => {
        ws.send(JSON.stringify({ action: "subscribe", unitType: "queue-worker" }));
        await sleep(100);
        const enqueued = await enqueueWorker("echo-worker", { phase: 1 });
        runIdA = enqueued.runId;
      });
      if (!wsEvents(phase1.filter((m) => m.parsed?.runId === runIdA)).includes("queueWorker.completed"))
        throw new Error(`phase 1: did not observe completion for run A`);

      // Phase 2: enqueue B while disconnected, wait for it to finish.
      const { runId: runIdB } = await enqueueWorker("echo-worker", { phase: 2 });
      await pollUntilTerminal("echo-worker", runIdB);

      // Phase 3: reconnect, enqueue C, collect events.
      let runIdC;
      const phase3 = await wsCollect(toWsUrl(PROJECT_ID), 5_000, async (ws) => {
        ws.send(JSON.stringify({ action: "subscribe", unitType: "queue-worker" }));
        await sleep(100);
        const enqueued = await enqueueWorker("echo-worker", { phase: 3 });
        runIdC = enqueued.runId;
      });

      const eventsForB = phase3.filter((m) => m.parsed?.runId === runIdB);
      const eventsForC = phase3.filter((m) => m.parsed?.runId === runIdC);

      if (eventsForB.length > 0)
        throw new Error(`run B events replayed after reconnect (${eventsForB.length} events)`);
      if (!wsEvents(eventsForC).includes("queueWorker.completed"))
        throw new Error(`run C events not received after reconnect`);
    },
  },
];

const WS_STAGE_RUNTIME = [
  {
    name: "ws-stage-connects",
    run: async () => {
      const ws = await wsOpen(toWsStageUrl(PROJECT_ID, STAGE_RUNTIME_ID));
      ws.close();
    },
  },
  {
    name: "ws-stage-receives-stage-enqueued-event",
    run: async () => {
      let runId;
      const msgs = await wsCollect(toWsStageUrl(PROJECT_ID, STAGE_RUNTIME_ID), 5_000, async (ws) => {
        ws.send(JSON.stringify({ action: "subscribe", unitType: "queue-worker" }));
        await sleep(100);
        const enqueued = await enqueueStageWorker("echo-worker", { wsQwStage: 1 });
        runId = enqueued.runId;
      });
      const forRun = msgs.filter((m) => m.parsed?.runId === runId);
      if (!wsEvents(forRun).includes("queueWorker.queued")) {
        throw new Error(`missing queueWorker.queued for stage run; got ${JSON.stringify(wsEvents(forRun))}`);
      }
      const qu = forRun.find((m) => m.parsed?.event === "queueWorker.queued");
      const sid = qu?.parsed?.stageRuntimeId;
      const want = STAGE_RUNTIME_ID.replace(/-/g, "").toLowerCase();
      if (!sid || String(sid).replace(/-/g, "").toLowerCase() !== want) {
        throw new Error(`expected stageRuntimeId ${STAGE_RUNTIME_ID}, got ${JSON.stringify(sid)}`);
      }
    },
  },
  {
    name: "ws-stage-socket-excludes-prod-queue-worker-events",
    run: async () => {
      let runId;
      const msgs = await wsCollect(toWsStageUrl(PROJECT_ID, STAGE_RUNTIME_ID), 4_000, async () => {
        const enqueued = await enqueueWorker("echo-worker", { wsQwExcludeStage: 1 });
        runId = enqueued.runId;
      });
      const qw = msgs.filter(
        (m) => typeof m.parsed?.event === "string" && String(m.parsed.event).startsWith("queueWorker."),
      );
      const forRun = qw.filter((m) => m.parsed?.runId === runId);
      if (forRun.length > 0) {
        throw new Error(`stage socket must not show prod run ${runId}; got ${forRun.length} qw events`);
      }
    },
  },
  {
    name: "ws-production-socket-excludes-stage-queue-worker-events",
    run: async () => {
      let runId;
      const msgs = await wsCollect(toWsUrl(PROJECT_ID), 4_500, async (ws) => {
        ws.send(JSON.stringify({ action: "subscribe", unitType: "queue-worker" }));
        await sleep(100);
        const enqueued = await enqueueStageWorker("echo-worker", { wsProdExcludeQw: 1 });
        runId = enqueued.runId;
      });
      const forRun = msgs.filter(
        (m) =>
          m.parsed?.runId === runId &&
          typeof m.parsed?.event === "string" &&
          String(m.parsed.event).startsWith("queueWorker."),
      );
      if (forRun.length > 0) {
        throw new Error(`prod socket must not show stage run ${runId}; got ${forRun.length} events`);
      }
    },
  },
  {
    name: "ws-stage-b-socket-excludes-stage-a-queue-worker-events",
    run: async () => {
      let runId;
      const msgs = await wsCollect(toWsStageUrl(PROJECT_ID, STAGE_B_RUNTIME_ID), 4_000, async (ws) => {
        ws.send(JSON.stringify({ action: "subscribe", unitType: "queue-worker" }));
        await sleep(100);
        const enq = await enqueueStageWorker("echo-worker", { wsQwCrossStg: 1 }, STAGE_RUNTIME_ID);
        runId = enq.runId;
      });
      const hit = msgs.filter(
        (m) =>
          m.parsed?.runId === runId &&
          typeof m.parsed?.event === "string" &&
          String(m.parsed.event).startsWith("queueWorker."),
      );
      if (hit.length > 0) {
        throw new Error(`stage-b ws must not show stage-a qw run ${runId}`);
      }
    },
  },
  {
    name: "ws-http-same-unit-path-stage-receives-homonymous-queued-event",
    run: async () => {
      const slug = "http-same-unit-path-runtime-isolation";
      let runId;
      const msgs = await wsCollect(toWsStageUrl(PROJECT_ID, STAGE_RUNTIME_ID), 5_000, async (ws) => {
        ws.send(JSON.stringify({ action: "subscribe", unitType: "queue-worker" }));
        await sleep(100);
        const enqueued = await enqueueStageWorker(slug, { marker: "ws-qw-stg", wsHttpSamePathQw: 1 });
        runId = enqueued.runId;
      });
      const forRun = msgs.filter((m) => m.parsed?.runId === runId);
      if (!wsEvents(forRun).includes("queueWorker.queued")) {
        throw new Error(`missing queueWorker.queued for homonymous stage worker; got ${JSON.stringify(wsEvents(forRun))}`);
      }
    },
  },
  {
    name: "ws-http-same-unit-path-stage-excludes-prod-homonymous-qw",
    run: async () => {
      const slug = "http-same-unit-path-runtime-isolation";
      let runId;
      const msgs = await wsCollect(toWsStageUrl(PROJECT_ID, STAGE_RUNTIME_ID), 4_000, async () => {
        const enqueued = await httpPost(qwUrl(slug), { marker: "ws-qw-prod-leak", wsHttpSamePathQwProd: 1 });
        if (enqueued.status !== 200 || !enqueued.body?.runId) {
          throw new Error(`prod enqueue homonymous qw: ${enqueued.status}`);
        }
        runId = enqueued.body.runId;
      });
      const qw = msgs.filter(
        (m) => typeof m.parsed?.event === "string" && String(m.parsed.event).startsWith("queueWorker."),
      );
      const forRun = qw.filter((m) => m.parsed?.runId === runId);
      if (forRun.length > 0) {
        throw new Error(`stage ws must not show prod homonymous qw ${runId}; got ${forRun.length}`);
      }
    },
  },
  {
    name: "ws-http-same-unit-path-prod-excludes-stage-homonymous-qw",
    run: async () => {
      const slug = "http-same-unit-path-runtime-isolation";
      let runId;
      const msgs = await wsCollect(toWsUrl(PROJECT_ID), 4_500, async (ws) => {
        ws.send(JSON.stringify({ action: "subscribe", unitType: "queue-worker" }));
        await sleep(100);
        const enqueued = await httpPost(qwStageUrl(slug, STAGE_RUNTIME_ID), {
          marker: "ws-qw-stg-leak",
          wsHttpSamePathQwStg: 1,
        });
        if (enqueued.status !== 200 || !enqueued.body?.runId) {
          throw new Error(`stage enqueue homonymous qw: ${enqueued.status}`);
        }
        runId = enqueued.body.runId;
      });
      const forRun = msgs.filter(
        (m) =>
          m.parsed?.runId === runId &&
          typeof m.parsed?.event === "string" &&
          String(m.parsed.event).startsWith("queueWorker."),
      );
      if (forRun.length > 0) {
        throw new Error(`prod ws must not show stage homonymous qw ${runId}; got ${forRun.length}`);
      }
    },
  },
  {
    name: "ws-http-same-unit-path-stage-b-excludes-stage-a-homonymous-qw-same-slug",
    run: async () => {
      const slug = "http-same-unit-path-runtime-isolation";
      let runId;
      const msgs = await wsCollect(toWsStageUrl(PROJECT_ID, STAGE_B_RUNTIME_ID), 4_000, async (ws) => {
        ws.send(JSON.stringify({ action: "subscribe", unitType: "queue-worker" }));
        await sleep(100);
        const enq = await enqueueStageWorker(slug, { marker: "ws-qw-cross-a", wsHttpSamePathQwAb: 1 }, STAGE_RUNTIME_ID);
        runId = enq.runId;
      });
      const hit = msgs.filter(
        (m) =>
          m.parsed?.runId === runId &&
          typeof m.parsed?.event === "string" &&
          String(m.parsed.event).startsWith("queueWorker."),
      );
      if (hit.length > 0) {
        throw new Error(`stage-b ws must not show stage-a homonymous qw run ${runId}`);
      }
    },
  },
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const sections = [
    { label: "ws_lifecycle", tests: WS_LIFECYCLE },
    { label: "ws_filtering", tests: WS_FILTERING },
    { label: "ws_edge_cases", tests: WS_EDGE_CASES },
    { label: "ws_stage_runtime", tests: WS_STAGE_RUNTIME },
  ];

  const flatTasks = sections.flatMap((section) =>
    section.tests.map((test) => ({ label: section.label, test })),
  );
  process.stderr.write(
    `\n  WebSocket: running ${flatTasks.length} cases in parallel (all sections)\n`,
  );
  const allResults = await Promise.all(
    flatTasks.map(({ label, test }) => runTest(label, test)),
  );

  const sectionResults = {};
  let flatIdx = 0;
  for (const section of sections) {
    const n = section.tests.length;
    sectionResults[section.label] = allResults.slice(flatIdx, flatIdx + n);
    flatIdx += n;
  }

  for (const section of sections) {
    const results = sectionResults[section.label];
    process.stderr.write(`\n  [${section.label}]\n`);
    for (let i = 0; i < section.tests.length; i++) {
      const test = section.tests[i];
      const result = results[i];
      process.stderr.write(`    ${test.name} … `);
      if (result.skipped) {
        process.stderr.write("SKIP\n");
      } else {
        process.stderr.write(result.pass ? "PASS\n" : `FAIL: ${result.error}\n`);
      }
    }
  }

  const summaryBySection = {};
  const detailsBySection = {};

  for (const [label, results] of Object.entries(sectionResults)) {
    const skipped = results.filter((r) => r.skipped).length;
    const passed = results.filter((r) => r.pass).length - skipped;
    const failed = results.length - passed - skipped;
    const total = results.length;
    summaryBySection[label] = { pass: failed === 0, passed, failed, skipped, total };
    detailsBySection[label] = {
      pass: failed === 0,
      tests: results.map((r) => ({
        name: r.name.replace(new RegExp(`^${label}: `), ""),
        pass: r.pass,
        ...(r.skipped ? { skipped: true } : {}),
        ...(r.error ? { error: r.error } : {}),
      })),
    };
  }

  const totalSkipped = allResults.filter((r) => r.skipped).length;
  const totalPassed = allResults.filter((r) => r.pass).length - totalSkipped;
  const totalFailed = allResults.length - totalPassed - totalSkipped;
  const totalTests = allResults.length;
  const healthy = totalFailed === 0;

  const report = {
    summary: {
      healthy,
      total_tests: totalTests,
      total_passed: totalPassed,
      total_failed: totalFailed,
      total_skipped: totalSkipped,
      sections: summaryBySection,
    },
    sections: detailsBySection,
    tests: allResults.map((r) => ({ name: r.name, pass: r.pass })),
  };

  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

main().catch((e) => {
  process.stderr.write(`FATAL: ${e.message ?? String(e)}\n`);
  process.exit(1);
});
