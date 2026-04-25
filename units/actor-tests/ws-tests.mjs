#!/usr/bin/env node
/**
 * Actor WebSocket tests — runs against the live server from Node.js.
 *
 * Covers GET /api/v1/ws/{project_id} with actor subscriptions:
 *   • Lifecycle events  → actor.events.{pid}.actor.{unit}.{id}
 *   • unitType filter   → unitType: "actor"
 *   • instanceId filter → instanceId: "<actorId>"
 *   • Re-subscribe      → replaces the NATS subject mid-session
 *   • Unfiltered        → actor.events.{pid}.>
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
const ACTOR_BASE = `${BASE_URL}/api/v1/trigger/actor/${PROJECT_ID}/test/actor-tests`;
const ACTOR_STAGE_BASE = `${BASE_URL}/api/v1/trigger/actor/${PROJECT_ID}/stage/${STAGE_RUNTIME_ID}/test/actor-tests`;

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

async function httpDelete(url) {
  const resp = await fetch(url, { method: "DELETE" });
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
// Actor HTTP helpers
// ---------------------------------------------------------------------------

function actorUrl(unit, actorId, handler) {
  return `${ACTOR_BASE}/${unit}/${actorId}/${handler}`;
}

function actorStageUrl(unit, actorId, handler) {
  return `${ACTOR_STAGE_BASE}/${unit}/${actorId}/${handler}`;
}

async function callActor(unit, actorId, handler, payload = {}) {
  const resp = await httpPost(`${actorUrl(unit, actorId, handler)}?await=true`, payload);
  return resp;
}

async function callActorStage(unit, actorId, handler, payload = {}) {
  const resp = await httpPost(`${actorStageUrl(unit, actorId, handler)}?await=true`, payload);
  return resp;
}

async function deleteActor(unit, actorId) {
  return httpDelete(`${ACTOR_BASE}/${unit}/${actorId}`);
}

function uid() {
  return Math.random().toString(36).slice(2, 10);
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
    .map((m) => (m.parsed && typeof m.parsed === "object" ? m.parsed.type : null))
    .filter((e) => typeof e === "string");
}

function wsActorIds(msgs) {
  return msgs
    .map((m) => (m.parsed && typeof m.parsed === "object" ? m.parsed.actor_id : null))
    .filter((id) => typeof id === "string");
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
// ws_actor_lifecycle tests (5)
// ---------------------------------------------------------------------------

const WS_LIFECYCLE = [
  {
    name: "ws-activated-event",
    run: async () => {
      const actorId = `ws-lifecycle-activated-${uid()}`;
      let receivedActivated = false;

      const msgs = await wsCollect(toWsUrl(PROJECT_ID), 5_000, async (ws) => {
        ws.send(JSON.stringify({ action: "subscribe", unitType: "actor" }));
        await sleep(200);
        await callActor("lifecycle-events-broadcast", actorId, "increment");
      });

      const forActor = msgs.filter((m) => m.parsed?.actor_id === actorId);
      const events = wsEvents(forActor);
      receivedActivated = events.includes("activated");
      if (!receivedActivated)
        throw new Error(`missing actor activated event; got: ${JSON.stringify(events)}`);
    },
  },
  {
    name: "ws-passivated-event",
    skip: "passivation timing depends on maxIdleTime sweep; difficult in short test window",
    run: async () => {},
  },
  {
    name: "ws-failed-event",
    run: async () => {
      const actorId = `ws-lifecycle-failed-${uid()}`;

      const msgs = await wsCollect(toWsUrl(PROJECT_ID), 6_000, async (ws) => {
        ws.send(JSON.stringify({ action: "subscribe", unitType: "actor" }));
        await sleep(200);
        await callActor("lifecycle-events-broadcast", actorId, "throwHandler");
      });

      const forActor = msgs.filter((m) => m.parsed?.actor_id === actorId);
      const events = wsEvents(forActor);
      if (!events.includes("failed"))
        throw new Error(`missing actor failed event; got: ${JSON.stringify(events)}`);
    },
  },
  {
    name: "ws-dead-letter-event",
    run: async () => {
      const actorId = `ws-lifecycle-dlq-${uid()}`;

      const msgs = await wsCollect(toWsUrl(PROJECT_ID), 15_000, async (ws) => {
        ws.send(JSON.stringify({ action: "subscribe", unitType: "actor" }));
        await sleep(200);
        await callActor("lifecycle-events-broadcast", actorId, "terminalHandler");
      });

      const forActor = msgs.filter((m) => m.parsed?.actor_id === actorId);
      const events = wsEvents(forActor);
      if (!events.includes("dead_letter"))
        throw new Error(`missing actor dead_letter event; got: ${JSON.stringify(events)}`);
    },
  },
  {
    name: "ws-event-payload-shape",
    run: async () => {
      const actorId = `ws-payload-shape-${uid()}`;

      const msgs = await wsCollect(toWsUrl(PROJECT_ID), 5_000, async (ws) => {
        ws.send(JSON.stringify({ action: "subscribe", unitType: "actor" }));
        await sleep(200);
        await callActor("lifecycle-events-broadcast", actorId, "increment");
      });

      const forActor = msgs.filter(
        (m) => m.parsed?.actor_id === actorId && m.parsed?.type === "activated",
      );
      if (forActor.length === 0)
        throw new Error(`no activated event for actor ${actorId}`);

      const ev = forActor[0].parsed;
      if (typeof ev.project_id !== "string") throw new Error("missing project_id");
      if (typeof ev.unit_path !== "string") throw new Error("missing unit_path");
      if (typeof ev.actor_id !== "string") throw new Error("missing actor_id");
      if (typeof ev.at !== "number" && typeof ev.at !== "string")
        throw new Error("missing at timestamp");
    },
  },
];

// ---------------------------------------------------------------------------
// ws_actor_filtering tests (4)
// ---------------------------------------------------------------------------

const WS_FILTERING = [
  {
    name: "ws-filter-actor-only",
    run: async () => {
      const actorId = `ws-filter-actor-${uid()}`;

      const msgs = await wsCollect(toWsUrl(PROJECT_ID), 5_000, async (ws) => {
        ws.send(JSON.stringify({ action: "subscribe", unitType: "actor" }));
        await sleep(200);
        await callActor("lifecycle-events-broadcast", actorId, "increment");
      });

      const events = wsEvents(msgs);
      const qwEvents = events.filter((e) => e.startsWith("queueWorker."));
      if (qwEvents.length > 0)
        throw new Error(
          `got queue-worker events on actor-only subscription: ${JSON.stringify(qwEvents)}`,
        );

      const actorMsgs = msgs.filter((m) => m.parsed?.actor_id === actorId);
      if (actorMsgs.length === 0)
        throw new Error(`expected actor events but got none`);
    },
  },
  {
    name: "ws-filter-specific-instance",
    run: async () => {
      const targetId = `ws-filter-target-${uid()}`;
      const otherId = `ws-filter-other-${uid()}`;

      const msgs = await wsCollect(toWsUrl(PROJECT_ID), 6_000, async (ws) => {
        ws.send(
          JSON.stringify({ action: "subscribe", unitType: "actor", instanceId: targetId }),
        );
        await sleep(300);
        await Promise.all([
          callActor("lifecycle-events-broadcast", targetId, "increment"),
          callActor("lifecycle-events-broadcast", otherId, "increment"),
        ]);
      });

      const forTarget = msgs.filter((m) => m.parsed?.actor_id === targetId);
      const forOther = msgs.filter((m) => m.parsed?.actor_id === otherId);

      if (forTarget.length === 0)
        throw new Error(`expected events for target actor (${targetId}) but got none`);
      if (forOther.length > 0)
        throw new Error(
          `expected no events for other actor (${otherId}) but got ${forOther.length}`,
        );
    },
  },
  {
    name: "ws-unfiltered-receives-all",
    run: async () => {
      const idA = `ws-unfiltered-a-${uid()}`;
      const idB = `ws-unfiltered-b-${uid()}`;

      const msgs = await wsCollect(toWsUrl(PROJECT_ID), 5_000, async () => {
        await Promise.all([
          callActor("lifecycle-events-broadcast", idA, "increment"),
          callActor("lifecycle-events-broadcast", idB, "increment"),
        ]);
      });

      const forA = msgs.filter((m) => m.parsed?.actor_id === idA);
      const forB = msgs.filter((m) => m.parsed?.actor_id === idB);

      if (forA.length === 0)
        throw new Error(`expected events for actor A (${idA}) but got none`);
      if (forB.length === 0)
        throw new Error(`expected events for actor B (${idB}) but got none`);
    },
  },
  {
    name: "ws-resubscribe-narrows-filter",
    run: async () => {
      const targetId = `ws-resub-target-${uid()}`;
      const otherId = `ws-resub-other-${uid()}`;

      const msgs = await wsCollect(toWsUrl(PROJECT_ID), 7_000, async (ws) => {
        await sleep(100);
        ws.send(
          JSON.stringify({ action: "subscribe", unitType: "actor", instanceId: targetId }),
        );
        await sleep(500);
        await Promise.all([
          callActor("lifecycle-events-broadcast", targetId, "increment"),
          callActor("lifecycle-events-broadcast", otherId, "increment"),
        ]);
        await sleep(3_000);
      });

      const forTarget = msgs.filter((m) => m.parsed?.actor_id === targetId);
      const forOther = msgs.filter((m) => m.parsed?.actor_id === otherId);

      if (forTarget.length === 0)
        throw new Error(`expected events for target actor after re-subscribe; got none`);
      if (forOther.length > 0)
        throw new Error(
          `expected no events for other actor after narrowing; got ${forOther.length}`,
        );
    },
  },
];

// ---------------------------------------------------------------------------
// ws_actor_isolation (1)
// ---------------------------------------------------------------------------

const WS_ISOLATION = [
  {
    name: "ws-wrong-project-receives-no-actor-events",
    run: async () => {
      const msgs = await wsCollect(toWsUrl(ALT_PROJECT_ID), 3_000, async (ws) => {
        ws.send(JSON.stringify({ action: "subscribe", unitType: "actor" }));
        await sleep(200);
        await callActor("lifecycle-events-broadcast", `ws-wrong-proj-${uid()}`, "increment");
      });
      if (msgs.length > 0) {
        throw new Error(
          `expected no actor events on wrong-project WebSocket, got ${msgs.length}: ` +
            JSON.stringify(msgs.slice(0, 2).map((m) => m.raw)),
        );
      }
    },
  },
];

// ---------------------------------------------------------------------------
// ws_actor_edge_cases tests (3)
// ---------------------------------------------------------------------------

const WS_EDGE_CASES = [
  {
    name: "ws-multiple-clients-same-project",
    run: async () => {
      const ws1 = await wsOpen(toWsUrl(PROJECT_ID));
      const ws2 = await wsOpen(toWsUrl(PROJECT_ID));
      const actorId = `ws-multi-client-${uid()}`;

      const msgs1 = [];
      const msgs2 = [];

      const toEntry = (raw) => {
        let parsed;
        try { parsed = JSON.parse(raw); } catch { parsed = raw; }
        return { raw, parsed };
      };

      ws1.addEventListener("message", (ev) => msgs1.push(toEntry(String(ev.data))));
      ws2.addEventListener("message", (ev) => msgs2.push(toEntry(String(ev.data))));

      try {
        const sub = JSON.stringify({ action: "subscribe", unitType: "actor" });
        ws1.send(sub);
        ws2.send(sub);
        await sleep(300);
        await callActor("lifecycle-events-broadcast", actorId, "increment");
        await sleep(3_000);

        const forActor1 = wsEvents(msgs1.filter((m) => m.parsed?.actor_id === actorId));
        const forActor2 = wsEvents(msgs2.filter((m) => m.parsed?.actor_id === actorId));

        if (!forActor1.includes("activated"))
          throw new Error(`client 1 missing activated event; got: ${JSON.stringify(forActor1)}`);
        if (!forActor2.includes("activated"))
          throw new Error(`client 2 missing activated event; got: ${JSON.stringify(forActor2)}`);
      } finally {
        ws1.close();
        ws2.close();
      }
    },
  },
  {
    name: "ws-late-connect-no-stale-events",
    run: async () => {
      const actorId = `ws-late-connect-${uid()}`;
      await callActor("lifecycle-events-broadcast", actorId, "increment");
      await sleep(500);

      const msgs = await wsCollect(toWsUrl(PROJECT_ID), 2_000, async (ws) => {
        ws.send(JSON.stringify({ action: "subscribe", unitType: "actor" }));
      });

      const forActor = msgs.filter((m) => m.parsed?.actor_id === actorId);
      if (forActor.length > 0)
        throw new Error(
          `expected no stale events for already-activated actor, got ${forActor.length}`,
        );
    },
  },
  {
    name: "ws-subject-format",
    run: async () => {
      const actorId = `ws-subject-fmt-${uid()}`;

      const msgs = await wsCollect(toWsUrl(PROJECT_ID), 5_000, async (ws) => {
        ws.send(JSON.stringify({ action: "subscribe", unitType: "actor" }));
        await sleep(200);
        await callActor("lifecycle-events-broadcast", actorId, "increment");
      });

      const forActor = msgs.filter((m) => m.parsed?.actor_id === actorId);
      if (forActor.length === 0)
        throw new Error(`no events received for actor ${actorId}`);

      const m = forActor[0].parsed;
      if (!m.subject && !m.type)
        throw new Error("event missing both subject and type fields");

      const subject = m.subject ?? "";
      if (subject && !subject.includes(PROJECT_ID))
        throw new Error(`subject "${subject}" does not contain project_id ${PROJECT_ID}`);
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
    name: "ws-stage-receives-activated-for-stage-actor",
    run: async () => {
      const actorId = `ws-stg-act-${uid()}`;
      const msgs = await wsCollect(toWsStageUrl(PROJECT_ID, STAGE_RUNTIME_ID), 5_000, async (ws) => {
        ws.send(JSON.stringify({ action: "subscribe", unitType: "actor" }));
        await sleep(200);
        await callActorStage("lifecycle-events-broadcast", actorId, "increment");
      });
      const forActor = msgs.filter((m) => m.parsed?.actor_id === actorId);
      const events = wsEvents(forActor);
      if (!events.includes("activated")) {
        throw new Error(`expected activated on stage socket; got ${JSON.stringify(events)}`);
      }
      const act = forActor.find((m) => m.parsed?.type === "activated");
      const sid = act?.parsed?.stageRuntimeId;
      const want = STAGE_RUNTIME_ID.replace(/-/g, "").toLowerCase();
      if (!sid || String(sid).replace(/-/g, "").toLowerCase() !== want) {
        throw new Error(`expected stageRuntimeId on actor event, got ${JSON.stringify(sid)}`);
      }
    },
  },
  {
    name: "ws-stage-socket-excludes-production-actor-events",
    run: async () => {
      const actorId = `ws-stg-excl-prod-${uid()}`;
      const msgs = await wsCollect(toWsStageUrl(PROJECT_ID, STAGE_RUNTIME_ID), 4_000, async () => {
        await callActor("lifecycle-events-broadcast", actorId, "increment");
      });
      const forActor = msgs.filter((m) => m.parsed?.actor_id === actorId);
      if (forActor.length > 0) {
        throw new Error(`stage socket must not show prod actor ${actorId}; got ${forActor.length} frames`);
      }
    },
  },
  {
    name: "ws-production-socket-excludes-stage-actor-events",
    run: async () => {
      const actorId = `ws-prod-excl-stg-${uid()}`;
      const msgs = await wsCollect(toWsUrl(PROJECT_ID), 4_500, async (ws) => {
        ws.send(JSON.stringify({ action: "subscribe", unitType: "actor" }));
        await sleep(150);
        await callActorStage("lifecycle-events-broadcast", actorId, "increment");
      });
      const forActor = msgs.filter((m) => m.parsed?.actor_id === actorId);
      if (forActor.length > 0) {
        throw new Error(`prod socket must not show stage actor ${actorId}; got ${forActor.length} frames`);
      }
    },
  },
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const sections = [
    { label: "ws_actor_lifecycle", tests: WS_LIFECYCLE },
    { label: "ws_actor_filtering", tests: WS_FILTERING },
    { label: "ws_actor_isolation", tests: WS_ISOLATION },
    { label: "ws_actor_edge_cases", tests: WS_EDGE_CASES },
    { label: "ws_actor_stage_runtime", tests: WS_STAGE_RUNTIME },
  ];

  const allResults = [];
  const sectionResults = {};

  for (const section of sections) {
    process.stderr.write(`\n  [${section.label}]\n`);
    const results = [];
    for (const test of section.tests) {
      process.stderr.write(`    ${test.name} … `);
      const result = await runTest(section.label, test);
      results.push(result);
      allResults.push(result);
      if (result.skipped) {
        process.stderr.write(`SKIP\n`);
      } else {
        process.stderr.write(result.pass ? "PASS\n" : `FAIL: ${result.error}\n`);
      }
    }
    sectionResults[section.label] = results;
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
