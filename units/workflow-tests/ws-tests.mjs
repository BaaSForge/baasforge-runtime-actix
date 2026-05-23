#!/usr/bin/env node
/**
 * WebSocket endpoint tests — runs against the live server from Node.js.
 *
 * These tests cannot run inside the QuickJS API runner because that runtime
 * is synchronous and has no real event loop.  This script uses Node's native
 * WebSocket (Node 22+) and the built-in `fetch` to drive workflows, then
 * asserts on the events streamed over the WebSocket connection.
 *
 * Exercises GET /api/v1/ws/{project_id}
 *   • Default subscription  → wf.events.{pid}.> + qw.events.{pid}.> + actor.events.{pid}.>
 *   • unitType filter        → wf.events.{pid}.workflow.>
 *   • instanceId filter      → wf.events.{pid}.workflow.{iid}
 *   • Re-subscribe           → replaces the NATS subject mid-session
 *
 * Usage (called by test.sh, but can also be run standalone):
 *   node ws-tests.mjs http://127.0.0.1:3334
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

const BASE_URL = process.argv[2] ?? "http://127.0.0.1:3334";
const PROJECT_ID = "00000000-aaaa-bbbb-cccc-000000000010";
const STAGE_RUNTIME_ID = "00000000-aaaa-bbbb-cccc-000000000022";
const STAGE_B_RUNTIME_ID = "00000000-aaaa-bbbb-cccc-000000000023";

const WF_BASE = `${BASE_URL}/api/v1/trigger/wf/${PROJECT_ID}/test/wf`;

// ---------------------------------------------------------------------------
// Helpers — HTTP
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

/** Start a workflow instance; throws on failure. */
async function epStart(slug, input = {}) {
  const resp = await httpPost(`${WF_BASE}/${slug}`, input);
  if (resp.status !== 200 || !resp.body?.instanceId) {
    throw new Error(`start ${slug} failed: ${resp.status} ${JSON.stringify(resp.body)}`);
  }
  return {
    instanceId: resp.body.instanceId,
    base: `${WF_BASE}/${slug}/${resp.body.instanceId}`,
  };
}

async function epStageStart(slug, input = {}, runtimeId = STAGE_RUNTIME_ID) {
  const root = `${BASE_URL}/api/v1/trigger/wf/${PROJECT_ID}/stage/${runtimeId}/test/wf`;
  const resp = await httpPost(`${root}/${slug}`, input);
  if (resp.status !== 200 || !resp.body?.instanceId) {
    throw new Error(`stage start ${slug} failed: ${resp.status} ${JSON.stringify(resp.body)}`);
  }
  const id = resp.body.instanceId;
  return {
    instanceId: id,
    base: `${root}/${slug}/${id}`,
  };
}

/** Poll until status matches target or times out; throws on timeout/failure. */
async function epPollStatus(instanceBase, target, maxIter = 120) {
  const seen = new Set();
  for (let i = 0; i < maxIter; i++) {
    await sleep(150);
    const resp = await httpGet(`${instanceBase}/status`);
    const st = resp.body?.meta?.status ?? "unknown";
    seen.add(`${String(st)}(http:${resp.status})`);
    if (st === target) return resp.body;
    if (st === "failed") throw new Error(`workflow failed while waiting for '${target}'`);
    if (resp.status >= 500)
      throw new Error(`status endpoint returned ${resp.status}: ${JSON.stringify(resp.body)}`);
  }
  throw new Error(`timed out waiting for '${target}' (saw: ${[...seen].join(", ")})`);
}

// ---------------------------------------------------------------------------
// Helpers — WebSocket
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
 * Connect to `url`, await `setup(ws)` once open, then collect all incoming
 * text frames for `durationMs` milliseconds, close, and return the messages.
 *
 * @param {string} url
 * @param {number} durationMs
 * @param {(ws: WebSocket) => Promise<void>} [setup]
 * @returns {Promise<Array<{raw: string, parsed: unknown}>>}
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

/** Return the `event` string field from each message that has one. */
function wsEvents(msgs) {
  return msgs
    .map((m) => (m.parsed && typeof m.parsed === "object" ? m.parsed.event : null))
    .filter((e) => typeof e === "string");
}

/** Return the `instanceId` string field from each message that has one. */
function wsInstanceIds(msgs) {
  return msgs
    .map((m) => (m.parsed && typeof m.parsed === "object" ? m.parsed.instanceId : null))
    .filter((id) => typeof id === "string");
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

async function runTest(test, labelPrefix = "endpoint_ws") {
  const label = `${labelPrefix}: ${test.name}`;
  try {
    await test.run();
    return { name: label, pass: true };
  } catch (e) {
    return { name: label, pass: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------------------
// Test definitions
// ---------------------------------------------------------------------------
//
// Subject topology (from src/routes/ws.rs + workflow_engine.rs):
//   published:  wf.events.{project_id}.workflow.{instance_id}
//   default WS: wf.events.{project_id}.>
//   unitType:   wf.events.{project_id}.workflow.>
//   instanceId: wf.events.{project_id}.workflow.{instance_id}
//
// Lifecycle events: workflow.started, workflow.completed,
//                   workflow.suspended, workflow.failed

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
    // At least one lifecycle event must arrive when a fast workflow runs.
    name: "ws-receives-events-on-workflow-run",
    run: async () => {
      const msgs = await wsCollect(toWsUrl(PROJECT_ID), 3_000, async () => {
        await epStart("echo-input", { v: 1 });
      });
      if (msgs.length === 0)
        throw new Error("expected at least one event, got none");
      const events = wsEvents(msgs);
      if (!events.includes("workflow.started") && !events.includes("workflow.completed"))
        throw new Error(`expected a lifecycle event; got: ${JSON.stringify(events)}`);
    },
  },
  {
    // Both workflow.started AND workflow.completed must be received for a
    // synchronously-completing workflow (echo-input).
    name: "ws-receives-started-and-completed-events",
    run: async () => {
      const msgs = await wsCollect(toWsUrl(PROJECT_ID), 4_000, async () => {
        await epStart("echo-input", { v: 2 });
      });
      const events = wsEvents(msgs);
      if (!events.includes("workflow.started"))
        throw new Error(`missing workflow.started; got: ${JSON.stringify(events)}`);
      if (!events.includes("workflow.completed"))
        throw new Error(`missing workflow.completed; got: ${JSON.stringify(events)}`);
    },
  },
  {
    // Every event frame must carry event, projectId, instanceId, timestamp.
    name: "ws-event-payload-has-required-fields",
    run: async () => {
      const msgs = await wsCollect(toWsUrl(PROJECT_ID), 4_000, async (ws) => {
        ws.send(JSON.stringify({ action: "subscribe", unitType: "workflow" }));
        await sleep(100);
        await epStart("echo-input", { v: 3 });
      });
      const events = msgs.filter(
        (m) => m.parsed && typeof m.parsed === "object" && "event" in m.parsed,
      );
      if (events.length === 0) throw new Error("no events received");
      for (const { raw, parsed: ev } of events) {
        if (!ev.event)     throw new Error(`missing 'event' field: ${raw}`);
        if (!ev.projectId) throw new Error(`missing 'projectId' field: ${raw}`);
        if (!ev.instanceId) throw new Error(`missing 'instanceId' field: ${raw}`);
        if (!ev.timestamp) throw new Error(`missing 'timestamp' field: ${raw}`);
      }
    },
  },
  {
    // {"action":"subscribe","unitType":"workflow"} narrows the NATS subject
    // to wf.events.{pid}.workflow.>  — events for workflow units still arrive.
    name: "ws-filter-by-unit-type-receives-events",
    run: async () => {
      const msgs = await wsCollect(toWsUrl(PROJECT_ID), 4_000, async (ws) => {
        ws.send(JSON.stringify({ action: "subscribe", unitType: "workflow" }));
        await sleep(100);
        await epStart("echo-input", { v: 4 });
      });
      const events = wsEvents(msgs);
      if (events.length === 0)
        throw new Error(
          `expected events after unitType filter but got none; ` +
            `raw frames: ${JSON.stringify(msgs.map((m) => m.raw).slice(0, 3))}`,
        );
    },
  },
  {
    // No filter: start two fast workflows; both instance IDs must appear in
    // the event stream.
    name: "ws-default-receives-events-from-multiple-workflows",
    run: async () => {
      let idA, idB;
      const msgs = await wsCollect(toWsUrl(PROJECT_ID), 4_000, async () => {
        const a = await epStart("echo-input", { seq: "a" });
        const b = await epStart("echo-input", { seq: "b" });
        idA = a.instanceId;
        idB = b.instanceId;
      });
      const ids = new Set(wsInstanceIds(msgs));
      if (!ids.has(idA))
        throw new Error(`no events for workflow A (${idA}); seen: ${[...ids].join(", ")}`);
      if (!ids.has(idB))
        throw new Error(`no events for workflow B (${idB}); seen: ${[...ids].join(", ")}`);
    },
  },
  {
    // Subscribe to a specific instanceId: only that instance's events must
    // appear; a separately-started workflow's events must be filtered out.
    //
    // Design: pre-position A (suspended, so its early events are already gone),
    // narrow the subscription to A, then start a fresh echo-input workflow for B
    // *after* the narrow subscription is in place.  This eliminates the race
    // condition that would arise from signalling a pre-started B while the server
    // is mid-resubscription.
    name: "ws-filter-by-instance-id-receives-only-matching-events",
    run: async () => {
      const { instanceId: idA, base: baseA } = await epStart("suspend-for-signal", {});
      await epPollStatus(baseA, "suspended");

      let idB;
      const msgs = await wsCollect(toWsUrl(PROJECT_ID), 5_000, async (ws) => {
        // Narrow to A only.
        ws.send(JSON.stringify({ action: "subscribe", unitType: "workflow", instanceId: idA }));
        // Wait for the server to drop the old NATS subscription and re-subscribe.
        await sleep(500);
        // Start B now — its events exist only after the narrow subscription is
        // active, so they must never reach this client.
        const b = await epStart("echo-input", { tag: "ws-filter-b" });
        idB = b.instanceId;
        // Complete A — its event must come through the narrow filter.
        await httpPost(`${baseA}/handlers/signal`, {});
      });

      const forA = msgs.filter((m) => m.parsed?.instanceId === idA);
      const forB = msgs.filter((m) => m.parsed?.instanceId === idB);

      if (forA.length === 0)
        throw new Error(`expected events for instance A (${idA}) but got none`);
      if (forB.length > 0)
        throw new Error(
          `expected no events for instance B (${idB}) but got ${forB.length}: ` +
            JSON.stringify(forB.map((m) => m.raw)),
        );
    },
  },
  {
    // Re-subscribe mid-session to narrow from a broad subject to one instance;
    // events from a workflow started after the re-subscribe must be filtered out.
    //
    // Design: same race-free approach — pre-position A, connect with no filter,
    // re-subscribe to A, then start a fresh echo-input workflow for C *after* the
    // re-subscribe is in place.  A's completion event is the positive assertion;
    // C's events are the negative assertion.
    name: "ws-resubscribe-narrows-filter-to-instance",
    run: async () => {
      const { instanceId: idA, base: baseA } = await epStart("suspend-for-signal", {});
      await epPollStatus(baseA, "suspended");

      let idC;
      const msgs = await wsCollect(toWsUrl(PROJECT_ID), 5_000, async (ws) => {
        // Re-subscribe to A only (server starts on broad wf.events.{pid}.>).
        ws.send(JSON.stringify({ action: "subscribe", unitType: "workflow", instanceId: idA }));
        // Wait for the server to resubscribe on NATS.
        await sleep(500);
        // Start C after the narrow subscription is active — its events must not
        // leak through.
        const c = await epStart("echo-input", { tag: "ws-resubscribe-c" });
        idC = c.instanceId;
        // Complete A — its event must arrive via the narrow filter.
        await httpPost(`${baseA}/handlers/signal`, {});
      });

      const forA = msgs.filter((m) => m.parsed?.instanceId === idA);
      const forC = msgs.filter((m) => m.parsed?.instanceId === idC);

      if (forA.length === 0)
        throw new Error(`expected events for A after re-subscribe; got none`);
      if (forC.length > 0)
        throw new Error(`expected no events for C after narrowing; got ${forC.length}`);
    },
  },
  {
    // A WS connected to a different project_id must receive nothing when
    // workflows run in the real project.
    name: "ws-wrong-project-receives-no-events",
    run: async () => {
      const wrongProjectId = "00000000-dead-beef-0000-000000000099";
      const msgs = await wsCollect(toWsUrl(wrongProjectId), 3_000, async () => {
        await epStart("echo-input", { v: 99 });
      });
      if (msgs.length > 0)
        throw new Error(
          `expected no events for wrong project but got ${msgs.length}: ` +
            JSON.stringify(msgs.map((m) => m.raw).slice(0, 2)),
        );
    },
  },
  {
    // An unrecognised action must NOT close the connection — subsequent
    // workflow events must still arrive.
    name: "ws-unknown-action-is-ignored-connection-stays-open",
    run: async () => {
      const msgs = await wsCollect(toWsUrl(PROJECT_ID), 3_500, async (ws) => {
        ws.send(JSON.stringify({ action: "invalid-action", data: 42 }));
        await sleep(200);
        await epStart("echo-input", { v: 100 });
      });
      const events = wsEvents(msgs);
      if (events.length === 0)
        throw new Error(
          `WS closed after unknown action or no events received; ` +
            `frames: ${JSON.stringify(msgs.map((m) => m.raw).slice(0, 3))}`,
        );
    },
  },
  {
    // workflow.suspended must arrive when a workflow waits on a promise;
    // workflow.completed must arrive once the promise is resolved via a signal.
    name: "ws-receives-suspended-then-completed-events",
    run: async () => {
      const { instanceId, base } = await epStart("suspend-for-signal", {});
      await epPollStatus(base, "suspended");

      const msgs = await wsCollect(toWsUrl(PROJECT_ID), 4_000, async (ws) => {
        ws.send(JSON.stringify({ action: "subscribe", unitType: "workflow", instanceId }));
        await sleep(200);
        await httpPost(`${base}/handlers/signal`, {});
      });

      const events = wsEvents(msgs);
      if (!events.includes("workflow.completed"))
        throw new Error(
          `expected workflow.completed after signal; got: ${JSON.stringify(events)}`,
        );
    },
  },
  {
    name: "ws-parallel-prod-and-stage-distinct-instance-ids",
    run: async () => {
      let prodId;
      let stageId;
      const [prodMsgs, stageMsgs] = await Promise.all([
        wsCollect(toWsUrl(PROJECT_ID), 6_000, async () => {
          const p = await epStart("echo-input", { lane: "prod" });
          prodId = p.instanceId;
        }),
        wsCollect(toWsStageUrl(PROJECT_ID, STAGE_RUNTIME_ID), 6_000, async () => {
          const s = await epStageStart("echo-input", { lane: "stage" });
          stageId = s.instanceId;
        }),
      ]);
      if (prodId === stageId) {
        throw new Error(`prod and stage returned identical instanceId: ${prodId}`);
      }
      const prodIds = new Set(wsInstanceIds(prodMsgs));
      const stageIds = new Set(wsInstanceIds(stageMsgs));
      if (!prodIds.has(prodId)) {
        throw new Error(`missing WS events for prod instance ${prodId}; saw ${[...prodIds].join(",")}`);
      }
      if (!stageIds.has(stageId)) {
        throw new Error(`missing WS events for stage instance ${stageId}; saw ${[...stageIds].join(",")}`);
      }
    },
  },
  {
    name: "ws-dual-narrow-filters-no-cross-talk-prod-vs-stage",
    run: async () => {
      const { instanceId: idProd, base: baseProd } = await epStart("suspend-for-signal", {});
      await epPollStatus(baseProd, "suspended");
      const { instanceId: idStage, base: baseStage } = await epStageStart("suspend-for-signal", {});
      await epPollStatus(baseStage, "suspended");

      const ws1 = await wsOpen(toWsUrl(PROJECT_ID));
      const ws2 = await wsOpen(toWsStageUrl(PROJECT_ID, STAGE_RUNTIME_ID));
      const m1 = [];
      const m2 = [];
      ws1.addEventListener("message", (ev) => {
        const raw = typeof ev.data === "string" ? ev.data : String(ev.data);
        try {
          m1.push(JSON.parse(raw));
        } catch {
          m1.push(raw);
        }
      });
      ws2.addEventListener("message", (ev) => {
        const raw = typeof ev.data === "string" ? ev.data : String(ev.data);
        try {
          m2.push(JSON.parse(raw));
        } catch {
          m2.push(raw);
        }
      });

      try {
        ws1.send(JSON.stringify({ action: "subscribe", unitType: "workflow", instanceId: idProd }));
        ws2.send(JSON.stringify({ action: "subscribe", unitType: "workflow", instanceId: idStage }));
        await sleep(500);
        await httpPost(`${baseStage}/handlers/signal`, {});
        await httpPost(`${baseProd}/handlers/signal`, {});
        await sleep(3_000);
      } finally {
        ws1.close();
        ws2.close();
      }

      const badOn1 = m1.filter((x) => x && typeof x === "object" && x.instanceId === idStage);
      const badOn2 = m2.filter((x) => x && typeof x === "object" && x.instanceId === idProd);
      if (badOn1.length > 0) {
        throw new Error(`client bound to prod instance saw stage instance events: ${badOn1.length}`);
      }
      if (badOn2.length > 0) {
        throw new Error(`client bound to stage instance saw prod instance events: ${badOn2.length}`);
      }
      const done1 = m1.some((x) => x?.event === "workflow.completed" && x.instanceId === idProd);
      const done2 = m2.some((x) => x?.event === "workflow.completed" && x.instanceId === idStage);
      if (!done1) throw new Error(`client 1 never saw workflow.completed for ${idProd}`);
      if (!done2) throw new Error(`client 2 never saw workflow.completed for ${idStage}`);
    },
  },
];

const STAGE_WS_TESTS = [
  {
    name: "ws-stage-url-connects",
    run: async () => {
      const ws = await wsOpen(toWsStageUrl(PROJECT_ID, STAGE_RUNTIME_ID));
      ws.close();
    },
  },
  {
    name: "ws-stage-receives-stage-workflow-lifecycle",
    run: async () => {
      const msgs = await wsCollect(toWsStageUrl(PROJECT_ID, STAGE_RUNTIME_ID), 5_000, async () => {
        await epStageStart("echo-input", { wsStage: true });
      });
      const wfEv = wsEvents(msgs).filter((e) => e.startsWith("workflow."));
      if (!wfEv.includes("workflow.started") && !wfEv.includes("workflow.completed")) {
        throw new Error(`expected workflow lifecycle on stage socket; got ${JSON.stringify(wfEv)}`);
      }
    },
  },
  {
    name: "ws-stage-socket-excludes-production-workflow-events",
    run: async () => {
      let prodIid;
      const msgs = await wsCollect(toWsStageUrl(PROJECT_ID, STAGE_RUNTIME_ID), 4_000, async () => {
        const s = await epStart("echo-input", { wsStageExcludeProd: true });
        prodIid = s.instanceId;
      });
      const leaked = msgs.filter(
        (m) =>
          typeof m.parsed?.event === "string" &&
          String(m.parsed.event).startsWith("workflow.") &&
          m.parsed?.instanceId === prodIid,
      );
      if (leaked.length > 0) {
        throw new Error(
          `stage socket must not deliver prod workflow frames for ${prodIid}; got ${leaked.length}`,
        );
      }
    },
  },
  {
    name: "ws-production-socket-excludes-stage-workflow-events",
    run: async () => {
      let stageIid;
      const msgs = await wsCollect(toWsUrl(PROJECT_ID), 4_500, async () => {
        const s = await epStageStart("echo-input", { wsProdExcludeStage: true });
        stageIid = s.instanceId;
      });
      const leaked = msgs.filter(
        (m) =>
          typeof m.parsed?.event === "string" &&
          String(m.parsed.event).startsWith("workflow.") &&
          m.parsed?.instanceId === stageIid,
      );
      if (leaked.length > 0) {
        throw new Error(
          `prod socket must not deliver stage workflow frames for ${stageIid}; got ${leaked.length}`,
        );
      }
    },
  },
  {
    name: "ws-stage-b-socket-excludes-stage-a-workflow-subscribed-by-instance-id",
    run: async () => {
      const { instanceId, base } = await epStageStart("suspend-for-signal", { wsStgAb: 1 }, STAGE_RUNTIME_ID);
      await epPollStatus(base, "suspended");
      const msgs = await wsCollect(toWsStageUrl(PROJECT_ID, STAGE_B_RUNTIME_ID), 5_000, async (ws) => {
        ws.send(JSON.stringify({ action: "subscribe", unitType: "workflow", instanceId }));
        await sleep(200);
        await httpPost(`${base}/handlers/signal`, {});
        await epStageStart("echo-input", { wsStgAbNoise: 1 }, STAGE_B_RUNTIME_ID);
      });
      const leak = msgs.filter(
        (m) =>
          m.parsed &&
          typeof m.parsed === "object" &&
          m.parsed.instanceId === instanceId &&
          typeof m.parsed.event === "string" &&
          String(m.parsed.event).startsWith("workflow."),
      );
      if (leak.length > 0) {
        throw new Error(
          `stage-b ws must not deliver stage-a workflow frames for ${instanceId}; got ${leak.length}`,
        );
      }
    },
  },
  {
    name: "ws-http-same-unit-path-stage-receives-homonymous-workflow-lifecycle",
    run: async () => {
      const slug = "http-same-unit-path-runtime-isolation";
      const msgs = await wsCollect(toWsStageUrl(PROJECT_ID, STAGE_RUNTIME_ID), 5_000, async () => {
        await epStageStart(slug, { marker: "ws-stg", wsHttpSamePathWf: true }, STAGE_RUNTIME_ID);
      });
      const wfEv = wsEvents(msgs).filter((e) => e.startsWith("workflow."));
      if (!wfEv.includes("workflow.started") && !wfEv.includes("workflow.completed")) {
        throw new Error(`expected lifecycle for homonymous stage wf; got ${JSON.stringify(wfEv)}`);
      }
    },
  },
  {
    name: "ws-http-same-unit-path-stage-excludes-prod-homonymous-workflow",
    run: async () => {
      const slug = "http-same-unit-path-runtime-isolation";
      let prodIid;
      const msgs = await wsCollect(toWsStageUrl(PROJECT_ID, STAGE_RUNTIME_ID), 4_000, async () => {
        const s = await epStart(slug, { marker: "ws-prod-leak", wsHttpSamePathWfProd: true });
        prodIid = s.instanceId;
      });
      const leaked = msgs.filter(
        (m) =>
          typeof m.parsed?.event === "string" &&
          String(m.parsed.event).startsWith("workflow.") &&
          m.parsed?.instanceId === prodIid,
      );
      if (leaked.length > 0) {
        throw new Error(
          `stage ws must not deliver prod homonymous wf frames for ${prodIid}; got ${leaked.length}`,
        );
      }
    },
  },
  {
    name: "ws-http-same-unit-path-prod-excludes-stage-homonymous-workflow",
    run: async () => {
      const slug = "http-same-unit-path-runtime-isolation";
      let stageIid;
      const msgs = await wsCollect(toWsUrl(PROJECT_ID), 4_500, async () => {
        const s = await epStageStart(
          slug,
          { marker: "ws-stg-leak", wsHttpSamePathWfStg: true },
          STAGE_RUNTIME_ID,
        );
        stageIid = s.instanceId;
      });
      const leaked = msgs.filter(
        (m) =>
          typeof m.parsed?.event === "string" &&
          String(m.parsed.event).startsWith("workflow.") &&
          m.parsed?.instanceId === stageIid,
      );
      if (leaked.length > 0) {
        throw new Error(
          `prod ws must not deliver stage homonymous wf frames for ${stageIid}; got ${leaked.length}`,
        );
      }
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
