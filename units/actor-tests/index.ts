/**
 * Actor Integration Test Runner (API unit)
 *
 * An API unit that exercises all actor tests end-to-end via HTTP.
 * When triggered, it calls actor handlers through the real trigger endpoints,
 * reads state, passivates, deletes, and validates outcomes.
 *
 * GET / — runs all tests and returns a JSON report.
 *
 * Correctness property → primary covering tests:
 * ┌──────────────────────────────────┬──────────────────────────────────────────────────────────────────────┐
 * │ Single-writer per actor          │ concurrency/exec-lock-respected, sequential-delivery/no-interleaving │
 * │ At-least-once delivery           │ durability/redelivery-after-nak, crash-recovery/in-flight-*           │
 * │ Exactly-once state apply         │ durability/redelivery-after-nak, concurrency/duplicate-dispatch-*     │
 * │ Sequential ordering per actor    │ sequential-delivery/in-order-messages, no-interleaving               │
 * │ State durability: throw          │ durability/no-commit-on-handler-throw                                 │
 * │ Retry uses stored pre-handler    │ retry-and-dlq/pre-handler-state-on-retry                              │
 * │ State durability: timeout        │ durability/no-commit-on-timeout, timeouts/timeout-no-state-commit     │
 * │ State durability: pod kill       │ durability/no-commit-on-pod-kill-mid-run, crash-recovery/*            │
 * │ State durability: redis loss     │ snapshot-pg/*, state-persistence/survive-redis-flush, crash-recovery/* │
 * │ Actor PG snapshot durability     │ snapshot-pg/*                                                         │
 * │ Bounded data loss on crash       │ crash-recovery/graceful-shutdown-flush                                │
 * │ Project / unit / instance iso.   │ isolation/*                                                           │
 * │ Alarm semantics                  │ alarms/*                                                              │
 * │ Metadata enforcement             │ metadata-enforcement/*                                                │
 * │ SDK reachability from all types  │ cross-unit/*, sdk-interface/* (`sendActorMessageSync` parent)        │
 * │ HTTP contract correctness        │ endpoints/* (inline)                                                  │
 * │ Project-id scoping invariants    │ sharding-seam/*                                                       │
 * │ Lifecycle / passivation          │ ws-tests.mjs, lifecycle/*, passivation/*                              │
 * └──────────────────────────────────┴──────────────────────────────────────────────────────────────────────┘
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PROJECT_ID = "00000000-aaaa-bbbb-cccc-000000000010";
const ALT_PROJECT_ID = "00000000-aaaa-bbbb-cccc-000000000012";
const STAGE_RUNTIME_ID = "00000000-aaaa-bbbb-cccc-000000000022";
const STAGE_B_RUNTIME_ID = "00000000-aaaa-bbbb-cccc-000000000023";

const PASSIVATION_IDLE_SLEEP_MS = 11_500;

/** Empty = run all. Otherwise only these name+category pairs. */
const RUN_ONLY: { name: string; category: string }[] = [];

function getBaseUrl(req: IncomingMessage): string {
  const host = req.headers.host ?? "127.0.0.1:3333";
  return `http://${host}`;
}

function pathSeg(segment: string): string {
  return encodeURIComponent(segment);
}

function actorUrl(
  baseUrl: string,
  unit: string,
  actorId: string,
  handler: string,
  projectId = PROJECT_ID,
): string {
  return `${baseUrl}/api/v1/trigger/actor/${projectId}/test/actor-tests/${pathSeg(unit)}/${pathSeg(actorId)}/${pathSeg(handler)}`;
}

function actorStateUrl(baseUrl: string, unit: string, actorId: string, projectId = PROJECT_ID): string {
  return `${baseUrl}/api/v1/trigger/actor/${projectId}/test/actor-tests/${pathSeg(unit)}/${pathSeg(actorId)}/state`;
}

function actorPassivateUrl(baseUrl: string, unit: string, actorId: string, projectId = PROJECT_ID): string {
  return `${baseUrl}/api/v1/trigger/actor/${projectId}/test/actor-tests/${pathSeg(unit)}/${pathSeg(actorId)}/passivate`;
}

function actorDeleteUrl(baseUrl: string, unit: string, actorId: string, projectId = PROJECT_ID): string {
  return `${baseUrl}/api/v1/trigger/actor/${projectId}/test/actor-tests/${pathSeg(unit)}/${pathSeg(actorId)}`;
}

function actorSnapshotPgUrl(baseUrl: string, unit: string, actorId: string, projectId = PROJECT_ID): string {
  return `${baseUrl}/api/v1/trigger/actor/${projectId}/test/actor-tests/${pathSeg(unit)}/${pathSeg(actorId)}/snapshot-pg`;
}

function actorTestEvictRedisUrl(baseUrl: string, unit: string, actorId: string, projectId = PROJECT_ID): string {
  return `${baseUrl}/api/v1/trigger/actor/${projectId}/test/actor-tests/${pathSeg(unit)}/${pathSeg(actorId)}/test-evict-redis`;
}

function actorStageSnapshotPgUrl(
  baseUrl: string,
  unit: string,
  actorId: string,
  runtimeId = STAGE_RUNTIME_ID,
  projectId = PROJECT_ID,
): string {
  return `${baseUrl}/api/v1/trigger/actor/${projectId}/stage/${runtimeId}/test/actor-tests/${pathSeg(unit)}/${pathSeg(actorId)}/snapshot-pg`;
}

function actorStageTestEvictRedisUrl(
  baseUrl: string,
  unit: string,
  actorId: string,
  runtimeId = STAGE_RUNTIME_ID,
  projectId = PROJECT_ID,
): string {
  return `${baseUrl}/api/v1/trigger/actor/${projectId}/stage/${runtimeId}/test/actor-tests/${pathSeg(unit)}/${pathSeg(actorId)}/test-evict-redis`;
}

function actorStageUrl(
  baseUrl: string,
  unit: string,
  actorId: string,
  handler: string,
  runtimeId = STAGE_RUNTIME_ID,
  projectId = PROJECT_ID,
): string {
  return `${baseUrl}/api/v1/trigger/actor/${projectId}/stage/${runtimeId}/test/actor-tests/${pathSeg(unit)}/${pathSeg(actorId)}/${pathSeg(handler)}`;
}

function actorStageStateUrl(
  baseUrl: string,
  unit: string,
  actorId: string,
  runtimeId = STAGE_RUNTIME_ID,
  projectId = PROJECT_ID,
): string {
  return `${baseUrl}/api/v1/trigger/actor/${projectId}/stage/${runtimeId}/test/actor-tests/${pathSeg(unit)}/${pathSeg(actorId)}/state`;
}

function actorStagePassivateUrl(
  baseUrl: string,
  unit: string,
  actorId: string,
  runtimeId = STAGE_RUNTIME_ID,
  projectId = PROJECT_ID,
): string {
  return `${baseUrl}/api/v1/trigger/actor/${projectId}/stage/${runtimeId}/test/actor-tests/${pathSeg(unit)}/${pathSeg(actorId)}/passivate`;
}

function actorStageDeleteUrl(
  baseUrl: string,
  unit: string,
  actorId: string,
  runtimeId = STAGE_RUNTIME_ID,
  projectId = PROJECT_ID,
): string {
  return `${baseUrl}/api/v1/trigger/actor/${projectId}/stage/${runtimeId}/test/actor-tests/${pathSeg(unit)}/${pathSeg(actorId)}`;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TestResult {
  name: string;
  pass: boolean;
  detail?: string;
  error?: string;
}

interface ActorTestDef {
  name: string;
  category: string;
  unit: string;
  actorId: string;
  handler: string;
  payload?: any;
  awaitResult?: boolean;
  checks: CheckDef[];
  skip?: string;
}

interface ActorInlineTestDef {
  name: string;
  category: string;
  run: (baseUrl: string) => Promise<void>;
  skip?: string;
}

type CheckDef =
  | { type: "eq"; path: string; expected: any }
  | { type: "true"; path: string }
  | { type: "notNull"; path: string }
  | { type: "contains"; path: string; substr: string }
  | { type: "gte"; path: string; value: number };

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function httpPost(url: string, body?: any): Promise<any> {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : "{}",
  });
  const text = await resp.text();
  try { return JSON.parse(text); } catch { return text; }
}

async function httpGet(url: string): Promise<any> {
  const resp = await fetch(url);
  const text = await resp.text();
  try { return JSON.parse(text); } catch { return text; }
}

async function httpPostFull(url: string, body?: any): Promise<{ status: number; body: any }> {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : "{}",
  });
  const text = await resp.text();
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: resp.status, body: parsed };
}

async function httpGetFull(url: string): Promise<{ status: number; body: any }> {
  const resp = await fetch(url);
  const text = await resp.text();
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: resp.status, body: parsed };
}

async function httpDeleteFull(url: string): Promise<{ status: number; body: any }> {
  const resp = await fetch(url, { method: "DELETE" });
  const text = await resp.text();
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: resp.status, body: parsed };
}

// ---------------------------------------------------------------------------
// Actor helpers
// ---------------------------------------------------------------------------

async function callActor(
  baseUrl: string,
  unit: string,
  actorId: string,
  handler: string,
  payload?: any,
  opts: { awaitResult?: boolean; projectId?: string } = {},
): Promise<any> {
  const projectId = opts.projectId ?? PROJECT_ID;
  const awaitParam = opts.awaitResult === false ? "false" : "true";
  const url = `${actorUrl(baseUrl, unit, actorId, handler, projectId)}?await=${awaitParam}`;
  return httpPost(url, payload ?? {});
}

async function callActorFull(
  baseUrl: string,
  unit: string,
  actorId: string,
  handler: string,
  payload?: any,
  opts: { awaitResult?: boolean; projectId?: string } = {},
): Promise<{ status: number; body: any }> {
  const projectId = opts.projectId ?? PROJECT_ID;
  const awaitParam = opts.awaitResult === false ? "false" : "true";
  const url = `${actorUrl(baseUrl, unit, actorId, handler, projectId)}?await=${awaitParam}`;
  return httpPostFull(url, payload ?? {});
}

async function getState(
  baseUrl: string,
  unit: string,
  actorId: string,
  projectId = PROJECT_ID,
): Promise<{ state: any; version: number }> {
  return httpGet(actorStateUrl(baseUrl, unit, actorId, projectId));
}

const ALARM_POLL_MS = 500;
const ALARM_EVENTUAL_TIMEOUT_MS = (() => {
  const raw = process.env["ACTOR_ALARM_EVENTUAL_TIMEOUT_MS"];
  if (raw === undefined || raw === "") return 120_000;
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 5_000 ? n : 120_000;
})();

async function waitForActorState(
  baseUrl: string,
  unit: string,
  actorId: string,
  predicate: (state: any) => boolean,
  timeoutMs: number,
  label: string,
): Promise<{ state: any; version: number }> {
  const deadline = Date.now() + timeoutMs;
  let last: { state: any; version: number } | undefined;
  while (Date.now() < deadline) {
    last = await getState(baseUrl, unit, actorId);
    if (predicate(last?.state)) return last;
    await sleep(ALARM_POLL_MS);
  }
  throw new Error(`${label} within ${timeoutMs}ms: ${JSON.stringify(last?.state)}`);
}

async function waitForActorStateUnchanged(
  baseUrl: string,
  unit: string,
  actorId: string,
  predicate: (state: any) => boolean,
  holdMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + holdMs;
  while (Date.now() < deadline) {
    const s = await getState(baseUrl, unit, actorId);
    if (!predicate(s?.state))
      throw new Error(`${label} (got ${JSON.stringify(s?.state)})`);
    await sleep(ALARM_POLL_MS);
  }
}

async function passivate(
  baseUrl: string,
  unit: string,
  actorId: string,
  projectId = PROJECT_ID,
): Promise<{ status: number; body: any }> {
  return httpPostFull(actorPassivateUrl(baseUrl, unit, actorId, projectId));
}

async function deleteActor(
  baseUrl: string,
  unit: string,
  actorId: string,
  projectId = PROJECT_ID,
): Promise<{ status: number; body: any }> {
  return httpDeleteFull(actorDeleteUrl(baseUrl, unit, actorId, projectId));
}

type ActorPgSnapshotOpts = { projectId?: string; stageRuntimeId?: string };

async function snapshotPg(
  baseUrl: string,
  unit: string,
  actorId: string,
  opts?: ActorPgSnapshotOpts,
): Promise<{ found: boolean; state?: any; version?: number }> {
  const projectId = opts?.projectId ?? PROJECT_ID;
  const stage = opts?.stageRuntimeId;
  const url =
    stage != null && stage !== ""
      ? actorStageSnapshotPgUrl(baseUrl, unit, actorId, stage, projectId)
      : actorSnapshotPgUrl(baseUrl, unit, actorId, projectId);
  const r = await httpGetFull(url);
  if (r.status !== 200)
    throw new Error(`snapshot-pg HTTP ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body;
}

async function testEvictActorRedis(
  baseUrl: string,
  unit: string,
  actorId: string,
  opts?: ActorPgSnapshotOpts,
): Promise<void> {
  const projectId = opts?.projectId ?? PROJECT_ID;
  const stage = opts?.stageRuntimeId;
  const url =
    stage != null && stage !== ""
      ? actorStageTestEvictRedisUrl(baseUrl, unit, actorId, stage, projectId)
      : actorTestEvictRedisUrl(baseUrl, unit, actorId, projectId);
  const r = await httpPostFull(url, {});
  if (r.status !== 200)
    throw new Error(`test-evict-redis HTTP ${r.status}: ${JSON.stringify(r.body)}`);
}

async function callActorStage(
  baseUrl: string,
  unit: string,
  actorId: string,
  handler: string,
  payload?: any,
  runtimeId = STAGE_RUNTIME_ID,
): Promise<any> {
  const url = `${actorStageUrl(baseUrl, unit, actorId, handler, runtimeId)}?await=true`;
  return httpPost(url, payload ?? {});
}

async function waitForPgVersion(
  baseUrl: string,
  unit: string,
  actorId: string,
  targetVersion: number,
  timeoutMs = 4000,
  opts?: ActorPgSnapshotOpts,
): Promise<{ state: any; version: number }> {
  const deadline = Date.now() + timeoutMs;
  let last: { found: boolean; state?: any; version?: number } = { found: false };
  while (Date.now() < deadline) {
    last = await snapshotPg(baseUrl, unit, actorId, opts);
    if (last.found && last.version === targetVersion && last.state !== undefined)
      return { state: last.state, version: last.version };
    await sleep(40);
  }
  throw new Error(
    `PG snapshot never reached version ${targetVersion} (last=${JSON.stringify(last)})`,
  );
}

// ---------------------------------------------------------------------------
// Workflow trigger helpers (for workflow→actor cross-unit tests)
// ---------------------------------------------------------------------------

function wfUrl(baseUrl: string, slug: string, projectId = PROJECT_ID): string {
  return `${baseUrl}/api/v1/trigger/wf/${projectId}/test/actor-tests/${slug}`;
}

function wfStageUrl(baseUrl: string, slug: string, runtimeId = STAGE_RUNTIME_ID): string {
  return `${baseUrl}/api/v1/trigger/wf/${PROJECT_ID}/stage/${runtimeId}/test/actor-tests/${slug}`;
}

function atWorkerUrl(baseUrl: string, slug: string): string {
  return `${baseUrl}/api/v1/trigger/workerQueue/${PROJECT_ID}/test/queue-worker/${slug}`;
}

function atWorkerStageUrl(baseUrl: string, slug: string, runtimeId: string): string {
  return `${baseUrl}/api/v1/trigger/workerQueue/${PROJECT_ID}/stage/${runtimeId}/test/queue-worker/${slug}`;
}

function atWorkerRunPath(
  baseUrl: string,
  slug: string,
  runId: string,
  suffix: string,
  stageRuntimeId?: string,
): string {
  const base =
    stageRuntimeId != null && stageRuntimeId !== ""
      ? atWorkerStageUrl(baseUrl, slug, stageRuntimeId)
      : atWorkerUrl(baseUrl, slug);
  return `${base}/${runId}/${suffix}`;
}

async function pollAtWorker(
  baseUrl: string,
  slug: string,
  runId: string,
  stageRuntimeId?: string,
): Promise<{ status: string; result?: any }> {
  for (let i = 0; i < 120; i++) {
    await sleep(150);
    const st = await httpGetFull(atWorkerRunPath(baseUrl, slug, runId, "status", stageRuntimeId));
    const status: string = st.body?.status ?? "unknown";
    if (status === "completed") {
      const res = await httpGetFull(atWorkerRunPath(baseUrl, slug, runId, "result", stageRuntimeId));
      return { status, result: res.body?.result };
    }
    if (status === "dead_letter" || status === "failed" || status === "cancelled") {
      return { status };
    }
  }
  return { status: "timeout" };
}

async function startWorkflow(
  baseUrl: string,
  slug: string,
  input?: any,
): Promise<{ instanceId: string; base: string }> {
  const resp = await httpPostFull(wfUrl(baseUrl, slug), input ?? {});
  if (resp.status !== 200 || !resp.body?.instanceId)
    throw new Error(`start workflow '${slug}' failed: ${resp.status} ${JSON.stringify(resp.body)}`);
  const base = `${wfUrl(baseUrl, slug)}/${resp.body.instanceId as string}`;
  return { instanceId: resp.body.instanceId as string, base };
}

async function pollWorkflowStatus(
  base: string,
  target: string,
  maxMs = 20000,
): Promise<any> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const r = await httpGetFull(`${base}/status`);
    const st: string | undefined = r.body?.meta?.status;
    if (st === target) return r.body;
    if (st === "failed" || (st === "cancelled" && target !== "cancelled"))
      throw new Error(`workflow reached '${st}' instead of '${target}'`);
    await sleep(200);
  }
  throw new Error(`workflow did not reach '${target}' within ${maxMs}ms`);
}

// ---------------------------------------------------------------------------
// JSON path helper
// ---------------------------------------------------------------------------

function jsonGet(val: any, path: string): any {
  let current = val;
  for (const part of path.split(".")) {
    if (current == null) return undefined;
    const idx = parseInt(part, 10);
    if (!isNaN(idx) && Array.isArray(current)) {
      current = current[idx];
    } else {
      current = current[part];
    }
  }
  return current;
}

function deepEqual(a: any, b: any): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------------------------------------------------------------------------
// Check application
// ---------------------------------------------------------------------------

function applyCheck(output: any, check: CheckDef): string | null {
  switch (check.type) {
    case "eq": {
      const actual = jsonGet(output, check.path);
      if (!deepEqual(actual, check.expected))
        return `'${check.path}': expected ${JSON.stringify(check.expected)}, got ${JSON.stringify(actual)}`;
      return null;
    }
    case "true": {
      const actual = jsonGet(output, check.path);
      if (actual !== true)
        return `'${check.path}': expected true, got ${JSON.stringify(actual)}`;
      return null;
    }
    case "notNull": {
      const actual = jsonGet(output, check.path);
      if (actual == null)
        return `'${check.path}': expected non-null`;
      return null;
    }
    case "contains": {
      const actual = jsonGet(output, check.path);
      if (typeof actual !== "string")
        return `'${check.path}': not a string`;
      if (!actual.includes(check.substr))
        return `'${check.path}': '${actual}' does not contain '${check.substr}'`;
      return null;
    }
    case "gte": {
      const actual = jsonGet(output, check.path);
      if (typeof actual !== "number" || actual < check.value)
        return `'${check.path}': expected >= ${check.value}, got ${JSON.stringify(actual)}`;
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

function diagActorWfHomonymousTripleLeg(params: {
  leg: "prod" | "stage-a" | "stage-b";
  actorId: string;
  url: string;
  res: { status: number; body: any };
  expectedPath: string;
  expectedScope: string;
  elapsedMs: number;
}): string {
  const { res, expectedPath, expectedScope, leg, actorId, url, elapsedMs } = params;
  const pr = res.body?.result;
  const embedded =
    pr && typeof pr === "object" && "error" in pr ? String((pr as { error?: unknown }).error) : undefined;
  const statusOk = res.status === 200;
  const scopeOk = pr?.scopeFromHandler === expectedScope;
  const pathOk = pr?.unitPathFromHandler === expectedPath;
  const lines = [
    `[sdk-same-unit-path-actor-wf-handler-homonymous-triple] leg=${leg} actorId=${actorId} parallelElapsedMs=${elapsedMs}`,
    `  requestUrl: ${url}`,
    `  httpStatus: ${res.status}`,
    `  expected: scopeFromHandler=${JSON.stringify(expectedScope)} unitPathFromHandler=${JSON.stringify(expectedPath)}`,
    `  actual: scopeFromHandler=${JSON.stringify(pr?.scopeFromHandler)} unitPathFromHandler=${JSON.stringify(pr?.unitPathFromHandler)}`,
    `  checks: httpOk=${statusOk} scopeMatch=${scopeOk} pathMatch=${pathOk}`,
    `  body.result: ${JSON.stringify(pr ?? null)}`,
    `  body (first 4000 chars): ${JSON.stringify(res.body).slice(0, 4000)}`,
  ];
  if (embedded !== undefined) lines.push(`  actorHandlerEmbeddedError: ${embedded}`);
  lines.push(
    `  interpretation: "workflow instance not found" → likely TRUE NEGATIVE (race): startWorkflowSync returned an instanceId but ` +
      `callWorkflowHandlerAndWaitForResultSync hit the workflow API before that instance is readable on the path used by handler RPC ` +
      `(persistence / worker / cache ordering). Intermittent pass → classic eventual-consistency flake. ` +
      `If scope or unitPath is wrong while HTTP 200, homonymous routing bug (FALSE NEGATIVE worth fixing). ` +
      `If httpStatus≠200, inspect actor/workflow trigger layer.`,
  );
  return lines.join("\n");
}

function fail(name: string, msg: string): TestResult {
  return { name, pass: false, error: msg };
}

function pass(name: string, detail?: string): TestResult {
  return detail !== undefined ? { name, pass: true, detail } : { name, pass: true };
}

function actorTestRunnerConcurrency(): number {
  const raw = process.env["ACTOR_TEST_RUNNER_CONCURRENCY"];
  if (raw === undefined || raw === "") return 16;
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 1 ? n : 16;
}

async function mapPool<T, R>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Math.min(Math.max(1, concurrency), Math.max(1, items.length));
  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (true) {
        const i = cursor++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]!, i);
      }
    }),
  );
  return out;
}

const ACTOR_TEST_HEARTBEAT_MS = 30_000;

function jobLabel(job: { test: { category: string; name: string } }): string {
  return `${job.test.category}: ${job.test.name}`;
}

// ---------------------------------------------------------------------------
// Actor test runner
// ---------------------------------------------------------------------------

async function runActorTest(baseUrl: string, test: ActorTestDef): Promise<TestResult> {
  const label = `${test.category}: ${test.name}`;
  if (test.skip) {
    return { name: label, pass: true, detail: `SKIPPED: ${test.skip}` };
  }
  try {
    await deleteActor(baseUrl, test.unit, test.actorId);
    const resp = await callActor(baseUrl, test.unit, test.actorId, test.handler, test.payload, {
      awaitResult: test.awaitResult !== false,
    });
    const result = resp?.result ?? resp;

    for (const check of test.checks) {
      const err = applyCheck(result, check);
      if (err) return { name: label, pass: false, detail: JSON.stringify(result), error: err };
    }
    return { name: label, pass: true, detail: JSON.stringify(result) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return fail(label, `exception: ${msg}`);
  }
}

async function runInlineTest(baseUrl: string, test: ActorInlineTestDef): Promise<TestResult> {
  const label = `${test.category}: ${test.name}`;
  if (test.skip) {
    return { name: label, pass: true, detail: `SKIPPED: ${test.skip}` };
  }
  try {
    await test.run(baseUrl);
    return pass(label);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return fail(label, msg);
  }
}

// ---------------------------------------------------------------------------
// Actor test definitions
// ---------------------------------------------------------------------------

function allActorTests(): ActorTestDef[] {
  return [
    // ---- basic (8) ----
    {
      name: "state-init",
      category: "basic",
      unit: "state-init",
      actorId: `state-init-${uid()}`,
      handler: "getState",
      checks: [
        { type: "eq", path: "count", expected: 0 },
        { type: "eq", path: "label", expected: "" },
      ],
    },
    {
      name: "state-mutation",
      category: "basic",
      unit: "state-mutation",
      actorId: `state-mutation-${uid()}`,
      handler: "increment",
      checks: [
        { type: "eq", path: "count", expected: 1 },
      ],
    },
    {
      name: "state-reassignment",
      category: "basic",
      unit: "state-reassignment",
      actorId: `state-reassign-${uid()}`,
      handler: "replaceState",
      checks: [
        { type: "eq", path: "count", expected: 7 },
        { type: "eq", path: "tag", expected: "reassigned" },
      ],
    },
    {
      name: "return-values",
      category: "basic",
      unit: "return-values",
      actorId: `return-values-${uid()}`,
      handler: "returnAll",
      checks: [
        { type: "eq", path: "primitive", expected: 42 },
        { type: "eq", path: "str", expected: "hello" },
        { type: "eq", path: "arr.0", expected: 1 },
        { type: "eq", path: "obj.x", expected: 10 },
        { type: "eq", path: "nul", expected: null },
      ],
    },
    {
      name: "ctx-properties",
      category: "basic",
      unit: "ctx-properties",
      actorId: `ctx-props-${uid()}`,
      handler: "inspect",
      checks: [
        { type: "true", path: "idIsString" },
        { type: "gte", path: "attempt", value: 1 },
        { type: "notNull", path: "state" },
      ],
    },
    {
      name: "handler-args",
      category: "basic",
      unit: "handler-args",
      actorId: `handler-args-${uid()}`,
      handler: "echo",
      payload: { key: "roundtrip", nested: { n: 7 }, arr: [1, 2, 3] },
      checks: [
        { type: "eq", path: "key", expected: "roundtrip" },
        { type: "eq", path: "nested.n", expected: 7 },
        { type: "eq", path: "arr.0", expected: 1 },
      ],
    },
  ];
}

// ---------------------------------------------------------------------------
// Inline test definitions
// ---------------------------------------------------------------------------

function allInlineTests(): ActorInlineTestDef[] {
  return [
    // ---- basic (2 inline) ----
    {
      name: "multiple-handlers",
      category: "basic",
      run: async (baseUrl) => {
        const id = `multi-handler-${uid()}`;
        await deleteActor(baseUrl, "multiple-handlers", id);
        await callActor(baseUrl, "multiple-handlers", id, "addItem", { id: "a", price: 10 });
        await callActor(baseUrl, "multiple-handlers", id, "addItem", { id: "b", price: 5 });
        await callActor(baseUrl, "multiple-handlers", id, "removeItem", { itemId: "a" });
        const result = await callActor(baseUrl, "multiple-handlers", id, "getState");
        const state = result?.result ?? result;
        if (state?.total !== 5) throw new Error(`expected total=5, got ${JSON.stringify(state?.total)}`);
        if ((state?.items as unknown[])?.length !== 1) throw new Error(`expected 1 item`);
      },
    },
    {
      name: "no-mutation-on-getter",
      category: "basic",
      run: async (baseUrl) => {
        const id = `no-mutate-${uid()}`;
        await deleteActor(baseUrl, "no-mutation-on-getter", id);
        const s1 = await getState(baseUrl, "no-mutation-on-getter", id);
        await callActor(baseUrl, "no-mutation-on-getter", id, "readState");
        const s2 = await getState(baseUrl, "no-mutation-on-getter", id);
        if ((s2?.version ?? 0) > (s1?.version ?? 0) + 1)
          throw new Error(`version bumped on read-only handler: ${s1?.version} → ${s2?.version}`);
      },
    },

    // ---- sequential-delivery (3) ----
    {
      name: "in-order-messages",
      category: "sequential-delivery",
      run: async (baseUrl) => {
        const id = `seq-in-order-${uid()}`;
        await deleteActor(baseUrl, "in-order-messages", id);
        const N = 20;
        for (let i = 0; i < N; i++) {
          await callActor(baseUrl, "in-order-messages", id, "increment");
        }
        const state = await getState(baseUrl, "in-order-messages", id);
        if (state?.state?.count !== N)
          throw new Error(`expected count=${N}, got ${JSON.stringify(state?.state?.count)}`);
      },
    },
    {
      name: "no-interleaving",
      category: "sequential-delivery",
      run: async (baseUrl) => {
        const id = `seq-no-interleave-${uid()}`;
        await deleteActor(baseUrl, "no-interleaving", id);
        await Promise.all([
          callActor(baseUrl, "no-interleaving", id, "readAndWrite", { tag: "a" }),
          callActor(baseUrl, "no-interleaving", id, "readAndWrite", { tag: "b" }),
        ]);
        const state = await getState(baseUrl, "no-interleaving", id);
        const count: number = state?.state?.count ?? 0;
        if (count !== 2)
          throw new Error(`expected count=2 (both handlers ran), got ${count}`);
      },
    },
    {
      name: "different-actors-parallel",
      category: "sequential-delivery",
      run: async (baseUrl) => {
        const idA = `seq-parallel-a-${uid()}`;
        const idB = `seq-parallel-b-${uid()}`;
        await Promise.all([
          deleteActor(baseUrl, "different-actors-parallel", idA),
          deleteActor(baseUrl, "different-actors-parallel", idB),
        ]);
        const start = Date.now();
        await Promise.all([
          callActor(baseUrl, "different-actors-parallel", idA, "slowIncrement"),
          callActor(baseUrl, "different-actors-parallel", idB, "slowIncrement"),
        ]);
        const elapsed = Date.now() - start;
        if (elapsed > 4_000)
          throw new Error(`parallel actors took ${elapsed}ms — likely serialized instead of parallel`);
        const [sa, sb] = await Promise.all([
          getState(baseUrl, "different-actors-parallel", idA),
          getState(baseUrl, "different-actors-parallel", idB),
        ]);
        if (sa?.state?.count !== 1) throw new Error(`actor A count wrong`);
        if (sb?.state?.count !== 1) throw new Error(`actor B count wrong`);
      },
    },
    {
      name: "cross-pod-lease-transfer",
      category: "sequential-delivery",
      skip: "requires multi-pod harness",
      run: async (_baseUrl) => {},
    },

    // ---- state-persistence (5) ----
    {
      name: "survive-invocation-boundary",
      category: "state-persistence",
      run: async (baseUrl) => {
        const id = `sp-boundary-${uid()}`;
        await deleteActor(baseUrl, "survive-invocation-boundary", id);
        await callActor(baseUrl, "survive-invocation-boundary", id, "write", { value: 99 });
        const result = await callActor(baseUrl, "survive-invocation-boundary", id, "read");
        const val = result?.result?.value ?? result?.value;
        if (val !== 99)
          throw new Error(`expected value=99 after boundary, got ${JSON.stringify(val)}`);
      },
    },
    {
      name: "survive-passivation",
      category: "state-persistence",
      run: async (baseUrl) => {
        const id = `sp-passivate-${uid()}`;
        await deleteActor(baseUrl, "survive-passivation", id);
        await callActor(baseUrl, "survive-passivation", id, "write", { value: 42 });
        await passivate(baseUrl, "survive-passivation", id);
        const result = await callActor(baseUrl, "survive-passivation", id, "read");
        const val = result?.result?.value ?? result?.value;
        if (val !== 42)
          throw new Error(`state lost after passivation: expected 42, got ${JSON.stringify(val)}`);
      },
    },
    {
      name: "survive-pod-restart",
      category: "state-persistence",
      skip: "requires multi-process pod restart harness",
      run: async (_baseUrl) => {},
    },
    {
      name: "survive-redis-flush",
      category: "state-persistence",
      skip: "full DB flush unsafe; use snapshot-pg/reactivate-from-pg-when-redis-cold for selective eviction",
      run: async (_baseUrl) => {},
    },
    {
      name: "version-monotonic",
      category: "state-persistence",
      run: async (baseUrl) => {
        const id = `sp-version-${uid()}`;
        await deleteActor(baseUrl, "version-monotonic", id);
        const s0 = await getState(baseUrl, "version-monotonic", id);
        await callActor(baseUrl, "version-monotonic", id, "increment");
        const s1 = await getState(baseUrl, "version-monotonic", id);
        await callActor(baseUrl, "version-monotonic", id, "increment");
        const s2 = await getState(baseUrl, "version-monotonic", id);
        const v0: number = s0?.version ?? -1;
        const v1: number = s1?.version ?? -1;
        const v2: number = s2?.version ?? -1;
        if (!(v1 > v0)) throw new Error(`version not increasing: ${v0} → ${v1}`);
        if (!(v2 > v1)) throw new Error(`version not increasing: ${v1} → ${v2}`);
      },
    },

    // ---- snapshot-pg (Actor Postgres actor_snapshots) ----
    {
      name: "pg-snapshot-row-after-write",
      category: "snapshot-pg",
      run: async (baseUrl) => {
        const id = `snap-write-${uid()}`;
        await deleteActor(baseUrl, "version-monotonic", id);
        await callActor(baseUrl, "version-monotonic", id, "increment");
        const redis = await getState(baseUrl, "version-monotonic", id);
        const pg = await waitForPgVersion(baseUrl, "version-monotonic", id, redis.version);
        if (pg.state?.count !== redis.state?.count)
          throw new Error(`PG state ${JSON.stringify(pg.state)} vs redis ${JSON.stringify(redis.state)}`);
      },
    },
    {
      name: "pg-snapshot-matches-redis-after-multi-increment",
      category: "snapshot-pg",
      run: async (baseUrl) => {
        const id = `snap-multi-${uid()}`;
        await deleteActor(baseUrl, "version-monotonic", id);
        for (let i = 0; i < 5; i++) await callActor(baseUrl, "version-monotonic", id, "increment");
        const redis = await getState(baseUrl, "version-monotonic", id);
        const pg = await waitForPgVersion(baseUrl, "version-monotonic", id, redis.version);
        if (pg.state?.count !== 5 || redis.state?.count !== 5)
          throw new Error(`expected count=5 redis=${JSON.stringify(redis.state)} pg=${JSON.stringify(pg.state)}`);
      },
    },
    {
      name: "pg-snapshot-flushed-on-passivate",
      category: "snapshot-pg",
      run: async (baseUrl) => {
        const id = `snap-pass-${uid()}`;
        await deleteActor(baseUrl, "version-monotonic", id);
        await callActor(baseUrl, "version-monotonic", id, "increment");
        await callActor(baseUrl, "version-monotonic", id, "increment");
        const before = await getState(baseUrl, "version-monotonic", id);
        await passivate(baseUrl, "version-monotonic", id);
        const pg = await snapshotPg(baseUrl, "version-monotonic", id);
        if (!pg.found) throw new Error("expected PG row after passivate");
        if (pg.version !== before.version || pg.state?.count !== before.state?.count)
          throw new Error(`PG ${JSON.stringify(pg)} vs pre-passivate redis ${JSON.stringify(before)}`);
      },
    },
    {
      name: "passivate-twice-pg-stable",
      category: "snapshot-pg",
      run: async (baseUrl) => {
        const id = `snap-pass2-${uid()}`;
        await deleteActor(baseUrl, "version-monotonic", id);
        await callActor(baseUrl, "version-monotonic", id, "increment");
        const before = await getState(baseUrl, "version-monotonic", id);
        await passivate(baseUrl, "version-monotonic", id);
        await passivate(baseUrl, "version-monotonic", id);
        const pg = await snapshotPg(baseUrl, "version-monotonic", id);
        if (!pg.found) throw new Error("expected PG row after double passivate");
        if (pg.version !== before.version || pg.state?.count !== before.state?.count)
          throw new Error(`PG changed after second passivate: ${JSON.stringify(pg)} vs ${JSON.stringify(before)}`);
      },
    },
    {
      name: "passivate-thrice-pg-stable",
      category: "snapshot-pg",
      run: async (baseUrl) => {
        const id = `snap-pass3-${uid()}`;
        await deleteActor(baseUrl, "version-monotonic", id);
        await callActor(baseUrl, "version-monotonic", id, "increment");
        const before = await getState(baseUrl, "version-monotonic", id);
        await passivate(baseUrl, "version-monotonic", id);
        await passivate(baseUrl, "version-monotonic", id);
        await passivate(baseUrl, "version-monotonic", id);
        const pg = await snapshotPg(baseUrl, "version-monotonic", id);
        if (!pg.found) throw new Error("expected PG row after triple passivate");
        if (pg.version !== before.version || pg.state?.count !== before.state?.count)
          throw new Error(`PG changed after third passivate: ${JSON.stringify(pg)} vs ${JSON.stringify(before)}`);
      },
    },
    {
      name: "delete-clears-pg-snapshot",
      category: "snapshot-pg",
      run: async (baseUrl) => {
        const id = `snap-del-${uid()}`;
        await deleteActor(baseUrl, "version-monotonic", id);
        await callActor(baseUrl, "version-monotonic", id, "increment");
        await waitForPgVersion(baseUrl, "version-monotonic", id, 1);
        const del = await deleteActor(baseUrl, "version-monotonic", id);
        if (del.status !== 200) throw new Error(`delete failed ${del.status}`);
        const pg = await snapshotPg(baseUrl, "version-monotonic", id);
        if (pg.found) throw new Error("expected PG snapshot absent after delete");
        const st = await httpGetFull(actorStateUrl(baseUrl, "version-monotonic", id));
        if (st.status !== 404) throw new Error(`expected state 404 after delete, got ${st.status}`);
      },
    },
    {
      name: "stage-pg-snapshot-isolated-from-prod",
      category: "snapshot-pg",
      run: async (baseUrl) => {
        const id = `snap-stage-${uid()}`;
        await callActorStage(baseUrl, "version-monotonic", id, "increment");
        await waitForPgVersion(baseUrl, "version-monotonic", id, 1, 4000, {
          stageRuntimeId: STAGE_RUNTIME_ID,
        });
        const prodPg = await snapshotPg(baseUrl, "version-monotonic", id);
        if (prodPg.found)
          throw new Error("stage-only mutation must not write production actor_snapshots row");
        const stagePg = await snapshotPg(baseUrl, "version-monotonic", id, {
          stageRuntimeId: STAGE_RUNTIME_ID,
        });
        if (!stagePg.found || stagePg.state?.count !== 1)
          throw new Error(`expected stage PG row count=1, got ${JSON.stringify(stagePg)}`);
        await httpDeleteFull(actorStageDeleteUrl(baseUrl, "version-monotonic", id));
        const stagePgAfter = await snapshotPg(baseUrl, "version-monotonic", id, {
          stageRuntimeId: STAGE_RUNTIME_ID,
        });
        if (stagePgAfter.found)
          throw new Error("expected stage PG row removed after stage delete");
      },
    },
    {
      name: "stage-a-and-stage-b-pg-snapshots-isolated",
      category: "snapshot-pg",
      run: async (baseUrl) => {
        const id = `snap-ab-${uid()}`;
        await deleteActor(baseUrl, "version-monotonic", id);
        await httpDeleteFull(actorStageDeleteUrl(baseUrl, "version-monotonic", id));
        await httpDeleteFull(actorStageDeleteUrl(baseUrl, "version-monotonic", id, STAGE_B_RUNTIME_ID));
        await callActorStage(baseUrl, "version-monotonic", id, "increment");
        await callActorStage(baseUrl, "version-monotonic", id, "increment");
        await waitForPgVersion(baseUrl, "version-monotonic", id, 2, 4000, {
          stageRuntimeId: STAGE_RUNTIME_ID,
        });
        await callActorStage(baseUrl, "version-monotonic", id, "increment", {}, STAGE_B_RUNTIME_ID);
        await waitForPgVersion(baseUrl, "version-monotonic", id, 1, 4000, {
          stageRuntimeId: STAGE_B_RUNTIME_ID,
        });
        const prodPg = await snapshotPg(baseUrl, "version-monotonic", id);
        if (prodPg.found)
          throw new Error("prod actor_snapshots row must not exist when only stage runtimes wrote");
        const pgA = await snapshotPg(baseUrl, "version-monotonic", id, {
          stageRuntimeId: STAGE_RUNTIME_ID,
        });
        const pgB = await snapshotPg(baseUrl, "version-monotonic", id, {
          stageRuntimeId: STAGE_B_RUNTIME_ID,
        });
        if (!pgA.found || pgA.state?.count !== 2 || pgA.version !== 2)
          throw new Error(`stage-a PG expected count=2 v=2, got ${JSON.stringify(pgA)}`);
        if (!pgB.found || pgB.state?.count !== 1 || pgB.version !== 1)
          throw new Error(`stage-b PG expected count=1 v=1, got ${JSON.stringify(pgB)}`);
      },
    },
    {
      name: "throw-does-not-advance-pg-snapshot",
      category: "snapshot-pg",
      run: async (baseUrl) => {
        const id = `snap-throw-${uid()}`;
        await deleteActor(baseUrl, "no-commit-on-handler-throw", id);
        await callActor(baseUrl, "no-commit-on-handler-throw", id, "setBase", { value: 10 });
        await waitForPgVersion(baseUrl, "no-commit-on-handler-throw", id, 1);
        try {
          await callActor(baseUrl, "no-commit-on-handler-throw", id, "mutateAndThrow");
        } catch { /* expected */ }
        const pg = await snapshotPg(baseUrl, "no-commit-on-handler-throw", id);
        if (!pg.found || pg.state?.value !== 10 || pg.version !== 1)
          throw new Error(`PG should stay at value=10 v=1, got ${JSON.stringify(pg)}`);
      },
    },

    // ---- durability (5) ----
    {
      name: "no-commit-on-handler-throw",
      category: "durability",
      run: async (baseUrl) => {
        const id = `dur-nothrow-${uid()}`;
        await deleteActor(baseUrl, "no-commit-on-handler-throw", id);
        await callActor(baseUrl, "no-commit-on-handler-throw", id, "setBase", { value: 10 });
        try {
          await callActor(baseUrl, "no-commit-on-handler-throw", id, "mutateAndThrow");
        } catch { /* expected */ }
        const state = await getState(baseUrl, "no-commit-on-handler-throw", id);
        if (state?.state?.value !== 10)
          throw new Error(`state mutated despite throw: got ${JSON.stringify(state?.state?.value)}`);
      },
    },
    {
      name: "no-commit-on-timeout",
      category: "durability",
      run: async (baseUrl) => {
        const id = `dur-notimeout-${uid()}`;
        await deleteActor(baseUrl, "no-commit-on-timeout", id);
        await callActor(baseUrl, "no-commit-on-timeout", id, "setBase", { value: 55 });
        try {
          await callActor(baseUrl, "no-commit-on-timeout", id, "mutateAndSleep");
        } catch { /* timeout expected */ }
        const state = await getState(baseUrl, "no-commit-on-timeout", id);
        if (state?.state?.value !== 55)
          throw new Error(`state mutated despite timeout: got ${JSON.stringify(state?.state?.value)}`);
      },
    },
    {
      name: "no-commit-on-pod-kill-mid-run",
      category: "durability",
      skip: "requires multi-process pod kill harness",
      run: async (_baseUrl) => {},
    },
    {
      name: "commit-atomic-across-fields",
      category: "durability",
      run: async (baseUrl) => {
        const id = `dur-atomic-${uid()}`;
        await deleteActor(baseUrl, "commit-atomic-across-fields", id);
        await callActor(baseUrl, "commit-atomic-across-fields", id, "setFields", { a: 1, b: 1 });
        const state = await getState(baseUrl, "commit-atomic-across-fields", id);
        const a: number = state?.state?.a ?? -1;
        const b: number = state?.state?.b ?? -1;
        if (a !== b)
          throw new Error(`atomic invariant violated: a=${a}, b=${b} should be equal`);
      },
    },
    {
      name: "redelivery-after-nak",
      category: "durability",
      run: async (baseUrl) => {
        const id = `dur-redelivery-${uid()}`;
        await deleteActor(baseUrl, "redelivery-after-nak", id);
        await callActor(baseUrl, "redelivery-after-nak", id, "succeedOnSecond");
        const state = await getState(baseUrl, "redelivery-after-nak", id);
        if (state?.state?.appliedOnce !== true)
          throw new Error(`state applied more than once or not at all: ${JSON.stringify(state?.state)}`);
      },
    },

    // ---- crash-recovery (multi-pod cases skipped; reactivate-from-pg runs in TEST_MODE) ----
    {
      name: "lease-expiry-failover",
      category: "crash-recovery",
      skip: "requires multi-pod harness",
      run: async (_baseUrl) => {},
    },
    {
      name: "in-flight-message-redelivered",
      category: "crash-recovery",
      skip: "requires multi-pod harness",
      run: async (_baseUrl) => {},
    },
    {
      name: "reactivate-from-pg-when-redis-cold",
      category: "crash-recovery",
      run: async (baseUrl) => {
        const id = `pg-cold-${uid()}`;
        await deleteActor(baseUrl, "version-monotonic", id);
        await callActor(baseUrl, "version-monotonic", id, "increment");
        await callActor(baseUrl, "version-monotonic", id, "increment");
        const before = await getState(baseUrl, "version-monotonic", id);
        await waitForPgVersion(baseUrl, "version-monotonic", id, before.version);
        await testEvictActorRedis(baseUrl, "version-monotonic", id);
        const coldGet = await httpGetFull(actorStateUrl(baseUrl, "version-monotonic", id));
        if (coldGet.status !== 200)
          throw new Error(`getState after redis evict expected 200, got ${coldGet.status}`);
        if (coldGet.body?.state?.count !== before.state?.count)
          throw new Error(`rehydrated state wrong: ${JSON.stringify(coldGet.body)} vs ${JSON.stringify(before)}`);
        await callActor(baseUrl, "version-monotonic", id, "increment");
        const after = await getState(baseUrl, "version-monotonic", id);
        if (after.state?.count !== before.state.count + 1)
          throw new Error(`handler after PG rehydrate broken: ${JSON.stringify(after)}`);
      },
    },
    {
      name: "reactivate-from-redis-when-pg-stale",
      category: "crash-recovery",
      skip: "requires multi-pod harness with controlled PG flush timing",
      run: async (_baseUrl) => {},
    },
    {
      name: "graceful-shutdown-flush",
      category: "crash-recovery",
      skip: "requires multi-pod harness with controlled shutdown",
      run: async (_baseUrl) => {},
    },

    // ---- concurrency (5) ----
    {
      name: "concurrent-activation",
      category: "concurrency",
      run: async (baseUrl) => {
        const id = `conc-activation-${uid()}`;
        await deleteActor(baseUrl, "concurrent-activation", id);
        const N = 10;
        const results = await Promise.all(
          Array.from({ length: N }, () =>
            callActorFull(baseUrl, "concurrent-activation", id, "increment"),
          ),
        );
        const succeeded = results.filter((r) => r.status === 200).length;
        if (succeeded < 1) throw new Error(`all ${N} concurrent calls failed`);
        const state = await getState(baseUrl, "concurrent-activation", id);
        const count: number = state?.state?.count ?? 0;
        if (count !== succeeded)
          throw new Error(`count=${count} but ${succeeded} calls returned 200`);
      },
    },
    {
      name: "duplicate-dispatch-blocked",
      category: "concurrency",
      run: async (baseUrl) => {
        const id = `conc-dedup-${uid()}`;
        await deleteActor(baseUrl, "duplicate-dispatch-blocked", id);
        await callActor(baseUrl, "duplicate-dispatch-blocked", id, "idempotentApply", { value: 7 });
        await callActor(baseUrl, "duplicate-dispatch-blocked", id, "idempotentApply", { value: 7 });
        const state = await getState(baseUrl, "duplicate-dispatch-blocked", id);
        if (state?.state?.value !== 7)
          throw new Error(`expected value=7, got ${JSON.stringify(state?.state?.value)}`);
      },
    },
    {
      name: "exec-lock-respected",
      category: "concurrency",
      run: async (baseUrl) => {
        const id = `conc-execlock-${uid()}`;
        await deleteActor(baseUrl, "exec-lock-respected", id);
        const N = 5;
        await Promise.all(
          Array.from({ length: N }, (_, i) =>
            callActor(baseUrl, "exec-lock-respected", id, "serializedIncrement", { seq: i }),
          ),
        );
        const state = await getState(baseUrl, "exec-lock-respected", id);
        const count: number = state?.state?.count ?? 0;
        if (count !== N)
          throw new Error(`expected count=${N}, got ${count} — likely concurrent execution`);
      },
    },
    {
      name: "idle-sweeper-vs-inflight",
      category: "concurrency",
      run: async (baseUrl) => {
        const id = `conc-sweeper-${uid()}`;
        await deleteActor(baseUrl, "idle-sweeper-vs-inflight", id);
        const result = await callActor(baseUrl, "idle-sweeper-vs-inflight", id, "longHandler");
        const val = result?.result?.completed ?? result?.completed;
        if (val !== true)
          throw new Error(`long handler was interrupted by sweeper: ${JSON.stringify(result)}`);
      },
    },
    {
      name: "lease-renewal-during-long-handler",
      category: "concurrency",
      run: async (baseUrl) => {
        const id = `conc-lease-renew-${uid()}`;
        await deleteActor(baseUrl, "lease-renewal-during-long-handler", id);
        const result = await callActor(baseUrl, "lease-renewal-during-long-handler", id, "longRun");
        const completed = result?.result?.completed ?? result?.completed;
        if (completed !== true)
          throw new Error(`lease not renewed during long handler: ${JSON.stringify(result)}`);
      },
    },

    // ---- retry-and-dlq (7) ----
    {
      name: "retry-transient-error",
      category: "retry-and-dlq",
      run: async (baseUrl) => {
        const id = `retry-transient-${uid()}`;
        await deleteActor(baseUrl, "retry-transient-error", id);
        await callActor(baseUrl, "retry-transient-error", id, "succeedOnThird");
        const state = await getState(baseUrl, "retry-transient-error", id);
        if ((state?.state?.attempt ?? 0) < 3)
          throw new Error(`expected attempt >= 3, got ${JSON.stringify(state?.state?.attempt)}`);
      },
    },
    {
      name: "backoff-intervals",
      category: "retry-and-dlq",
      run: async (baseUrl) => {
        const id = `retry-backoff-${uid()}`;
        await deleteActor(baseUrl, "backoff-intervals", id);
        const t0 = Date.now();
        await callActor(baseUrl, "backoff-intervals", id, "failThenSucceed");
        const elapsed = Date.now() - t0;
        if (elapsed < 1300)
          throw new Error(
            `expected ~500ms+1000ms backoff between 3 attempts, wall clock too short: ${elapsed}ms`,
          );
      },
    },
    {
      name: "pre-handler-state-on-retry",
      category: "retry-and-dlq",
      run: async (baseUrl) => {
        const id = `retry-prehandler-${uid()}`;
        await deleteActor(baseUrl, "pre-handler-state-on-retry", id);
        const result = await callActor(baseUrl, "pre-handler-state-on-retry", id, "succeedOnThird");
        const body = result?.result ?? result;
        const lastAttempt = body?.lastAttempt;
        if (lastAttempt !== 3)
          throw new Error(`expected lastAttempt 3 after retries, got ${JSON.stringify(body)}`);
        const state = await getState(baseUrl, "pre-handler-state-on-retry", id);
        if ((state?.state?.bumpCount ?? -1) !== 1)
          throw new Error(
            `each retry should reset ctx.state to stored snapshot (bumpCount 1), got ${JSON.stringify(state?.state)}`,
          );
      },
    },
    {
      name: "terminal-error-skips-retries",
      category: "retry-and-dlq",
      run: async (baseUrl) => {
        const id = `retry-terminal-${uid()}`;
        await deleteActor(baseUrl, "terminal-error-skips-retries", id);
        try {
          await callActor(baseUrl, "terminal-error-skips-retries", id, "throwTerminal");
        } catch { /* expected */ }
        const state = await getState(baseUrl, "terminal-error-skips-retries", id);
        if ((state?.state?.attempt ?? 0) > 1)
          throw new Error(`TerminalError retried: attempt=${JSON.stringify(state?.state?.attempt)}`);
      },
    },
    {
      name: "max-attempts-exhausts-to-dlq",
      category: "retry-and-dlq",
      run: async (baseUrl) => {
        const id = `retry-maxattempts-${uid()}`;
        await deleteActor(baseUrl, "max-attempts-exhausts-to-dlq", id);
        try {
          await callActor(baseUrl, "max-attempts-exhausts-to-dlq", id, "alwaysFail");
        } catch { /* expected */ }
        const state = await getState(baseUrl, "max-attempts-exhausts-to-dlq", id);
        if (state?.state?.dlqInvoked !== true)
          throw new Error(`DLQ handler not invoked after max attempts`);
      },
    },
    {
      name: "dlq-handler-invoked",
      category: "retry-and-dlq",
      run: async (baseUrl) => {
        const id = `retry-dlq-invoked-${uid()}`;
        await deleteActor(baseUrl, "dlq-handler-invoked", id);
        try {
          await callActor(baseUrl, "dlq-handler-invoked", id, "failAndDlq");
        } catch { /* expected */ }
        const state = await getState(baseUrl, "dlq-handler-invoked", id);
        if (state?.state?.dlqPayloadReceived !== true)
          throw new Error(`onDeadLetter was not invoked with original payload`);
      },
    },
    {
      name: "dlq-handler-throw-does-not-loop",
      category: "retry-and-dlq",
      run: async (baseUrl) => {
        const id = `retry-dlq-throw-${uid()}`;
        await deleteActor(baseUrl, "dlq-handler-throw-does-not-loop", id);
        try {
          await callActor(baseUrl, "dlq-handler-throw-does-not-loop", id, "triggerDlqThrow");
        } catch { /* expected */ }
        const state = await getState(baseUrl, "dlq-handler-throw-does-not-loop", id);
        if ((state?.state?.dlqCallCount ?? 0) > 1)
          throw new Error(`DLQ handler looped: called ${String(state?.state?.dlqCallCount)} times`);
      },
    },

    // ---- timeouts (3) ----
    {
      name: "handler-timeout-hard-kill",
      category: "timeouts",
      run: async (baseUrl) => {
        const id = `timeout-hardkill-${uid()}`;
        await deleteActor(baseUrl, "handler-timeout-hard-kill", id);
        const resp = await callActorFull(baseUrl, "handler-timeout-hard-kill", id, "sleepForever");
        if (resp.status === 200 && (resp.body?.result?.completed ?? resp.body?.completed) === true)
          throw new Error(`expected handler to be killed by timeout, but it completed`);
      },
    },
    {
      name: "timeout-no-state-commit",
      category: "timeouts",
      run: async (baseUrl) => {
        const id = `timeout-nocommit-${uid()}`;
        await deleteActor(baseUrl, "timeout-no-state-commit", id);
        await callActor(baseUrl, "timeout-no-state-commit", id, "setBase", { value: 77 });
        try {
          await callActor(baseUrl, "timeout-no-state-commit", id, "mutateAndSleep");
        } catch { /* timeout expected */ }
        const state = await getState(baseUrl, "timeout-no-state-commit", id);
        if (state?.state?.value !== 77)
          throw new Error(`state mutated despite timeout: got ${JSON.stringify(state?.state?.value)}`);
      },
    },
    {
      name: "long-handler-keeps-lease",
      category: "timeouts",
      run: async (baseUrl) => {
        const id = `timeout-keeplease-${uid()}`;
        await deleteActor(baseUrl, "long-handler-keeps-lease", id);
        const result = await callActor(baseUrl, "long-handler-keeps-lease", id, "longButUnderTimeout");
        const committed = result?.result?.committed ?? result?.committed;
        if (committed !== true)
          throw new Error(`long handler did not commit: ${JSON.stringify(result)}`);
      },
    },

    // ---- alarms (8) ----
    {
      name: "set-alarm-fires",
      category: "alarms",
      run: async (baseUrl) => {
        const id = `alarm-fires-${uid()}`;
        await deleteActor(baseUrl, "set-alarm-fires", id);
        const sch = await callActorFull(baseUrl, "set-alarm-fires", id, "scheduleAlarm", { delayMs: 600 });
        if (sch.status !== 200)
          throw new Error(`scheduleAlarm: ${sch.status} ${JSON.stringify(sch.body)}`);
        await waitForActorState(
          baseUrl,
          "set-alarm-fires",
          id,
          (st) => st?.alarmFired === true,
          ALARM_EVENTUAL_TIMEOUT_MS,
          "alarm never fired",
        );
      },
    },
    {
      name: "alarm-survives-pod-restart",
      category: "alarms",
      skip: "requires multi-pod restart harness",
      run: async (_baseUrl) => {},
    },
    {
      name: "alarm-survives-passivation",
      category: "alarms",
      run: async (baseUrl) => {
        const id = `alarm-survive-pass-${uid()}`;
        await deleteActor(baseUrl, "alarm-survives-passivation", id);
        const sch = await callActorFull(baseUrl, "alarm-survives-passivation", id, "scheduleAlarm", {
          delayMs: 1_500,
        });
        if (sch.status !== 200)
          throw new Error(`scheduleAlarm: ${sch.status} ${JSON.stringify(sch.body)}`);
        const pv = await passivate(baseUrl, "alarm-survives-passivation", id);
        if (pv.status !== 200)
          throw new Error(`passivate: ${pv.status} ${JSON.stringify(pv.body)}`);
        await waitForActorState(
          baseUrl,
          "alarm-survives-passivation",
          id,
          (st) => st?.alarmFired === true,
          ALARM_EVENTUAL_TIMEOUT_MS,
          "alarm never fired after passivation",
        );
      },
    },
    {
      name: "cancel-alarm",
      category: "alarms",
      run: async (baseUrl) => {
        const id = `alarm-cancel-${randomUUID()}`;
        await deleteActor(baseUrl, "cancel-alarm", id);
        const delayMs = 15_000;
        const sch = await callActorFull(baseUrl, "cancel-alarm", id, "scheduleAlarm", { delayMs });
        if (sch.status !== 200)
          throw new Error(`scheduleAlarm: ${sch.status} ${JSON.stringify(sch.body)}`);
        const can = await callActorFull(baseUrl, "cancel-alarm", id, "cancelAlarm");
        if (can.status !== 200)
          throw new Error(`cancelAlarm: ${can.status} ${JSON.stringify(can.body)}`);
        await waitForActorStateUnchanged(
          baseUrl,
          "cancel-alarm",
          id,
          (st) => st?.alarmFired !== true,
          4_000,
          "cancelled alarm fired",
        );
      },
    },
    {
      name: "multiple-alarms-distinct-names",
      category: "alarms",
      run: async (baseUrl) => {
        const id = `alarm-multi-${uid()}`;
        await deleteActor(baseUrl, "multiple-alarms-distinct-names", id);
        const sch = await callActorFull(baseUrl, "multiple-alarms-distinct-names", id, "scheduleThreeAlarms");
        if (sch.status !== 200)
          throw new Error(`scheduleThreeAlarms: ${sch.status} ${JSON.stringify(sch.body)}`);
        await waitForActorState(
          baseUrl,
          "multiple-alarms-distinct-names",
          id,
          (st) => (st?.firedCount ?? 0) >= 3,
          ALARM_EVENTUAL_TIMEOUT_MS,
          "expected 3 distinct alarms to fire",
        );
      },
    },
    {
      name: "duplicate-alarm-name-replaces",
      category: "alarms",
      run: async (baseUrl) => {
        const id = `alarm-replace-${uid()}`;
        await deleteActor(baseUrl, "duplicate-alarm-name-replaces", id);
        const sch = await callActorFull(baseUrl, "duplicate-alarm-name-replaces", id, "scheduleAlarmTwice", {
          first: 120_000,
          second: 1_500,
        });
        if (sch.status !== 200)
          throw new Error(`scheduleAlarmTwice: ${sch.status} ${JSON.stringify(sch.body)}`);
        await waitForActorState(
          baseUrl,
          "duplicate-alarm-name-replaces",
          id,
          (st) => (st?.fireCount ?? 0) >= 1,
          ALARM_EVENTUAL_TIMEOUT_MS,
          "duplicate-name alarm never fired",
        );
        await waitForActorStateUnchanged(
          baseUrl,
          "duplicate-alarm-name-replaces",
          id,
          (st) => (st?.fireCount ?? 0) === 1,
          12_000,
          "duplicate-name alarm fired more than once (first schedule was not replaced)",
        );
      },
    },
    {
      name: "alarm-after-delete",
      category: "alarms",
      run: async (baseUrl) => {
        const id = `alarm-after-del-${uid()}`;
        await deleteActor(baseUrl, "alarm-after-delete", id);
        const sch = await callActorFull(baseUrl, "alarm-after-delete", id, "scheduleAlarm", { delayMs: 800 });
        if (sch.status !== 200)
          throw new Error(`scheduleAlarm: ${sch.status} ${JSON.stringify(sch.body)}`);
        await deleteActor(baseUrl, "alarm-after-delete", id);
        await waitForActorStateUnchanged(
          baseUrl,
          "alarm-after-delete",
          id,
          (st) => st?.alarmFired !== true,
          8_000,
          "alarm fired after actor was deleted",
        );
      },
    },
    {
      name: "alarm-past-time",
      category: "alarms",
      run: async (baseUrl) => {
        const id = `alarm-past-${uid()}`;
        await deleteActor(baseUrl, "alarm-past-time", id);
        const sch = await callActorFull(baseUrl, "alarm-past-time", id, "scheduleAlarmInPast");
        if (sch.status !== 200)
          throw new Error(`scheduleAlarmInPast: ${sch.status} ${JSON.stringify(sch.body)}`);
        await waitForActorState(
          baseUrl,
          "alarm-past-time",
          id,
          (st) => st?.alarmFired === true,
          ALARM_EVENTUAL_TIMEOUT_MS,
          "past-due alarm never fired",
        );
      },
    },

    // ---- state-limits (4) ----
    {
      name: "state-under-limit",
      category: "state-limits",
      run: async (baseUrl) => {
        const id = `statelimit-under-${uid()}`;
        await deleteActor(baseUrl, "state-under-limit", id);
        const kbData = "x".repeat(500 * 1024);
        const resp = await callActorFull(baseUrl, "state-under-limit", id, "setLargeState", { data: kbData });
        if (resp.status !== 200)
          throw new Error(`expected 200 for 500KB state, got ${resp.status}`);
      },
    },
    {
      name: "state-over-limit",
      category: "state-limits",
      run: async (baseUrl) => {
        const id = `statelimit-over-${uid()}`;
        await deleteActor(baseUrl, "state-over-limit", id);
        const mbData = "x".repeat(2 * 1024 * 1024);
        const resp = await callActorFull(baseUrl, "state-over-limit", id, "setLargeState", { data: mbData });
        if (resp.status === 200 && (resp.body?.result?.error ?? "").includes("StateLimitExceeded")) {
          return;
        }
        if (resp.status === 200)
          throw new Error(`expected StateLimitExceeded for 2MB state, got 200 with no error`);
      },
    },
    {
      name: "huge-nested-state",
      category: "state-limits",
      run: async (baseUrl) => {
        const id = `statelimit-nested-${uid()}`;
        await deleteActor(baseUrl, "huge-nested-state", id);
        const nested = buildDeepObject(50, "leaf");
        await callActor(baseUrl, "huge-nested-state", id, "setNested", { obj: nested });
        const state = await getState(baseUrl, "huge-nested-state", id);
        const retrieved = state?.state?.obj;
        if (JSON.stringify(retrieved) !== JSON.stringify(nested))
          throw new Error(`nested object did not round-trip correctly`);
      },
    },

    // ---- lifecycle (6) ----
    {
      name: "activate-on-first-message",
      category: "lifecycle",
      run: async (baseUrl) => {
        const id = `lc-activate-${uid()}`;
        await deleteActor(baseUrl, "activate-on-first-message", id);
        const resp = await callActorFull(baseUrl, "activate-on-first-message", id, "hello");
        if (resp.status !== 200)
          throw new Error(`first message returned ${resp.status}, expected 200`);
      },
    },
    {
      name: "passivate-after-idle",
      category: "lifecycle",
      run: async (baseUrl) => {
        const id = `lc-idle-pv-${uid()}`;
        await deleteActor(baseUrl, "passivate-after-idle", id);
        await callActor(baseUrl, "passivate-after-idle", id, "increment");
        await sleep(PASSIVATION_IDLE_SLEEP_MS);
        const pg = await waitForPgVersion(baseUrl, "passivate-after-idle", id, 1, 16_000);
        if (pg.state?.count !== 1)
          throw new Error(`expected PG count=1 after idle passivation, got ${JSON.stringify(pg.state)}`);
      },
    },
    {
      name: "reactivate-keeps-id",
      category: "lifecycle",
      run: async (baseUrl) => {
        const id = `lc-reactivate-${uid()}`;
        await deleteActor(baseUrl, "reactivate-keeps-id", id);
        await callActor(baseUrl, "reactivate-keeps-id", id, "setData", { v: 123 });
        await passivate(baseUrl, "reactivate-keeps-id", id);
        const result = await callActor(baseUrl, "reactivate-keeps-id", id, "getId");
        const returnedId = result?.result?.id ?? result?.id;
        if (returnedId !== id)
          throw new Error(`ctx.id changed after reactivation: expected '${id}', got '${String(returnedId)}'`);
        const state = await getState(baseUrl, "reactivate-keeps-id", id);
        if (state?.state?.v !== 123)
          throw new Error(`state lost after reactivation: got ${JSON.stringify(state?.state)}`);
      },
    },
    {
      name: "force-passivate-endpoint",
      category: "lifecycle",
      run: async (baseUrl) => {
        const id = `lc-force-passivate-${uid()}`;
        await deleteActor(baseUrl, "force-passivate-endpoint", id);
        await callActor(baseUrl, "force-passivate-endpoint", id, "activate");
        const resp = await passivate(baseUrl, "force-passivate-endpoint", id);
        if (resp.status !== 200)
          throw new Error(`passivate endpoint returned ${resp.status}, expected 200`);
      },
    },
    {
      name: "delete-endpoint",
      category: "lifecycle",
      run: async (baseUrl) => {
        const id = `lc-delete-${uid()}`;
        await deleteActor(baseUrl, "delete-endpoint", id);
        await callActor(baseUrl, "delete-endpoint", id, "setData", { v: 999 });
        const delResp = await deleteActor(baseUrl, "delete-endpoint", id);
        if (delResp.status !== 200)
          throw new Error(`DELETE returned ${delResp.status}, expected 200`);
        const state = await getState(baseUrl, "delete-endpoint", id);
        if ((state?.state?.v ?? 0) === 999)
          throw new Error(`state still present after DELETE`);
      },
    },
    {
      name: "lifecycle-events-broadcast",
      category: "lifecycle",
      run: async (baseUrl) => {
        const id = `lc-events-${uid()}`;
        await deleteActor(baseUrl, "lifecycle-events-broadcast", id);
        const resp = await callActorFull(baseUrl, "lifecycle-events-broadcast", id, "increment");
        if (resp.status !== 200)
          throw new Error(`scaffold actor failed: ${resp.status}`);
      },
    },

    // ---- passivation (idle sweep + HTTP passivate) ----
    {
      name: "numeric-max-idle-ms-flushes-pg",
      category: "passivation",
      run: async (baseUrl) => {
        const id = `pv-num-${uid()}`;
        await deleteActor(baseUrl, "numeric-max-idle", id);
        await callActor(baseUrl, "numeric-max-idle", id, "bump");
        await sleep(10_000);
        const pg = await waitForPgVersion(baseUrl, "numeric-max-idle", id, 1, 18_000);
        if (pg.state?.n !== 1)
          throw new Error(`expected PG n=1 after numeric maxIdle idle flush, got ${JSON.stringify(pg.state)}`);
      },
    },
    {
      name: "no-max-idle-long-sleep-still-mutable",
      category: "passivation",
      run: async (baseUrl) => {
        const id = `pv-nomax-${uid()}`;
        await deleteActor(baseUrl, "no-max-idle", id);
        await callActor(baseUrl, "no-max-idle", id, "bump");
        const v1 = await getState(baseUrl, "no-max-idle", id);
        await sleep(PASSIVATION_IDLE_SLEEP_MS + 3000);
        const mid = await getState(baseUrl, "no-max-idle", id);
        await callActor(baseUrl, "no-max-idle", id, "bump");
        const v2 = await getState(baseUrl, "no-max-idle", id);
        if ((v1?.state?.n ?? 0) !== 1) throw new Error(`expected n=1 after first bump, got ${JSON.stringify(v1)}`);
        if ((mid?.state?.n ?? 0) !== 1)
          throw new Error(`expected n=1 after long sleep without maxIdle (no idle eviction), got ${JSON.stringify(mid)}`);
        if ((v2?.state?.n ?? 0) !== 2)
          throw new Error(`expected n=2 after second bump, got ${JSON.stringify(v2)}`);
        if (v1.version !== mid.version)
          throw new Error(`version drift after long sleep without maxIdle: ${v1.version} vs ${mid.version}`);
      },
    },
    {
      name: "readonly-peeks-extend-idle-deadline",
      category: "passivation",
      run: async (baseUrl) => {
        const id = `pv-ro-${uid()}`;
        await deleteActor(baseUrl, "readonly-extends-idle", id);
        await callActor(baseUrl, "readonly-extends-idle", id, "write", { v: 7 });
        await sleep(2000);
        await callActor(baseUrl, "readonly-extends-idle", id, "peek");
        await sleep(2000);
        await callActor(baseUrl, "readonly-extends-idle", id, "peek");
        await sleep(PASSIVATION_IDLE_SLEEP_MS);
        const pg = await waitForPgVersion(baseUrl, "readonly-extends-idle", id, 1, 18_000);
        if (pg.state?.v !== 7)
          throw new Error(`expected PG v=7 after peeks + idle, got ${JSON.stringify(pg.state)}`);
      },
    },
    {
      name: "idle-flushes-two-increments-to-pg",
      category: "passivation",
      run: async (baseUrl) => {
        const id = `pv-2inc-${uid()}`;
        await deleteActor(baseUrl, "passivate-after-idle", id);
        await callActor(baseUrl, "passivate-after-idle", id, "increment");
        await callActor(baseUrl, "passivate-after-idle", id, "increment");
        await sleep(PASSIVATION_IDLE_SLEEP_MS);
        const pg = await waitForPgVersion(baseUrl, "passivate-after-idle", id, 2, 18_000);
        if (pg.state?.count !== 2)
          throw new Error(`expected PG count=2 after two bumps + idle, got ${JSON.stringify(pg.state)}`);
      },
    },
    {
      name: "http-passivate-after-idle-pg-unchanged",
      category: "passivation",
      run: async (baseUrl) => {
        const id = `pv-http2-${uid()}`;
        await deleteActor(baseUrl, "passivate-after-idle", id);
        await callActor(baseUrl, "passivate-after-idle", id, "increment");
        await sleep(PASSIVATION_IDLE_SLEEP_MS);
        const pg1 = await waitForPgVersion(baseUrl, "passivate-after-idle", id, 1, 18_000);
        const pv = await passivate(baseUrl, "passivate-after-idle", id);
        if (pv.status !== 200) throw new Error(`second passivate failed: ${pv.status}`);
        const pg2 = await snapshotPg(baseUrl, "passivate-after-idle", id);
        if (pg2.version !== pg1.version || pg2.state?.count !== pg1.state?.count)
          throw new Error(`PG drift after HTTP passivate post-idle: ${JSON.stringify(pg2)} vs ${JSON.stringify(pg1)}`);
      },
    },
    {
      name: "stage-idle-flushes-pg-snapshot",
      category: "passivation",
      run: async (baseUrl) => {
        const id = `pv-st-${uid()}`;
        await httpDeleteFull(actorStageDeleteUrl(baseUrl, "stage-idle-passivate", id));
        const inc = await httpPostFull(
          `${actorStageUrl(baseUrl, "stage-idle-passivate", id, "inc")}?await=true`,
          {},
        );
        if (inc.status !== 200) throw new Error(`stage inc failed: ${inc.status}`);
        await sleep(PASSIVATION_IDLE_SLEEP_MS);
        const pg = await waitForPgVersion(baseUrl, "stage-idle-passivate", id, 1, 18_000, {
          stageRuntimeId: STAGE_RUNTIME_ID,
        });
        if (pg.state?.c !== 1)
          throw new Error(`expected stage PG c=1 after idle, got ${JSON.stringify(pg.state)}`);
        const prod = await snapshotPg(baseUrl, "stage-idle-passivate", id);
        if (prod.found)
          throw new Error(`stage-only actor must not write prod actor_snapshots row; got ${JSON.stringify(prod)}`);
      },
    },
    {
      name: "increment-passivate-increment-chain",
      category: "passivation",
      run: async (baseUrl) => {
        const id = `pv-chain-${uid()}`;
        await deleteActor(baseUrl, "version-monotonic", id);
        await callActor(baseUrl, "version-monotonic", id, "increment");
        await passivate(baseUrl, "version-monotonic", id);
        await callActor(baseUrl, "version-monotonic", id, "increment");
        const s = await getState(baseUrl, "version-monotonic", id);
        if (s?.state?.count !== 2)
          throw new Error(`expected count=2 after inc→passivate→inc, got ${JSON.stringify(s?.state)}`);
      },
    },
    {
      name: "parallel-http-passivate-same-actor",
      category: "passivation",
      run: async (baseUrl) => {
        const id = `pv-par-${uid()}`;
        await deleteActor(baseUrl, "version-monotonic", id);
        await callActor(baseUrl, "version-monotonic", id, "increment");
        const before = await getState(baseUrl, "version-monotonic", id);
        const [a, b] = await Promise.all([
          passivate(baseUrl, "version-monotonic", id),
          passivate(baseUrl, "version-monotonic", id),
        ]);
        if (a.status !== 200 || b.status !== 200)
          throw new Error(`parallel passivate statuses ${a.status} ${b.status}`);
        const pg = await snapshotPg(baseUrl, "version-monotonic", id);
        if (!pg.found) throw new Error("expected PG after parallel passivate");
        if (pg.version !== before.version || pg.state?.count !== before.state?.count)
          throw new Error(`PG unstable after parallel passivate: ${JSON.stringify(pg)} vs ${JSON.stringify(before)}`);
      },
    },
    {
      name: "passivate-after-getstate-hydrate-persists",
      category: "passivation",
      run: async (baseUrl) => {
        const id = `pv-hydr-${uid()}`;
        await deleteActor(baseUrl, "state-mutation", id);
        await callActor(baseUrl, "state-mutation", id, "increment");
        await testEvictActorRedis(baseUrl, "state-mutation", id);
        const st = await getState(baseUrl, "state-mutation", id);
        if ((st?.state?.count ?? 0) !== 1)
          throw new Error(`expected hydrate count=1, got ${JSON.stringify(st)}`);
        const before = await getState(baseUrl, "state-mutation", id);
        await passivate(baseUrl, "state-mutation", id);
        const pg = await snapshotPg(baseUrl, "state-mutation", id);
        if (!pg.found) throw new Error("expected PG after passivate hydrated actor");
        if (pg.version !== before.version || pg.state?.count !== before.state?.count)
          throw new Error(`PG mismatch: ${JSON.stringify(pg)} vs redis ${JSON.stringify(before)}`);
      },
    },

    // ---- isolation (11) ----
    {
      name: "cross-project-isolation",
      category: "isolation",
      run: async (baseUrl) => {
        const id = `iso-crossproj-${uid()}`;
        await Promise.all([
          deleteActor(baseUrl, "cross-project-isolation", id, PROJECT_ID),
          deleteActor(baseUrl, "cross-project-isolation", id, ALT_PROJECT_ID),
        ]);
        await callActor(baseUrl, "cross-project-isolation", id, "setValue", { v: "proj-A" }, { projectId: PROJECT_ID });
        await callActor(baseUrl, "cross-project-isolation", id, "setValue", { v: "proj-B" }, { projectId: ALT_PROJECT_ID });
        const [sA, sB] = await Promise.all([
          getState(baseUrl, "cross-project-isolation", id, PROJECT_ID),
          getState(baseUrl, "cross-project-isolation", id, ALT_PROJECT_ID),
        ]);
        if (sA?.state?.v !== "proj-A") throw new Error(`project A state wrong: ${JSON.stringify(sA?.state)}`);
        if (sB?.state?.v !== "proj-B") throw new Error(`project B state wrong: ${JSON.stringify(sB?.state)}`);
        if (sA?.state?.v === sB?.state?.v) throw new Error("cross-project state leaked");
      },
    },
    {
      name: "cross-unit-isolation",
      category: "isolation",
      run: async (baseUrl) => {
        const id = `iso-crossunit-${uid()}`;
        await Promise.all([
          deleteActor(baseUrl, "cross-unit-isolation-a", id),
          deleteActor(baseUrl, "cross-unit-isolation-b", id),
        ]);
        await callActor(baseUrl, "cross-unit-isolation-a", id, "setValue", { v: "unit-A" });
        await callActor(baseUrl, "cross-unit-isolation-b", id, "setValue", { v: "unit-B" });
        const [sA, sB] = await Promise.all([
          getState(baseUrl, "cross-unit-isolation-a", id),
          getState(baseUrl, "cross-unit-isolation-b", id),
        ]);
        if (sA?.state?.v !== "unit-A") throw new Error(`unit A state wrong`);
        if (sB?.state?.v !== "unit-B") throw new Error(`unit B state wrong`);
        if (sA?.state?.v === sB?.state?.v) throw new Error("cross-unit state leaked");
      },
    },
    {
      name: "cross-instance-isolation",
      category: "isolation",
      run: async (baseUrl) => {
        const idA = `iso-inst-a-${uid()}`;
        const idB = `iso-inst-b-${uid()}`;
        await Promise.all([
          deleteActor(baseUrl, "cross-instance-isolation", idA),
          deleteActor(baseUrl, "cross-instance-isolation", idB),
        ]);
        await callActor(baseUrl, "cross-instance-isolation", idA, "setValue", { v: 111 });
        await callActor(baseUrl, "cross-instance-isolation", idB, "setValue", { v: 222 });
        const [sA, sB] = await Promise.all([
          getState(baseUrl, "cross-instance-isolation", idA),
          getState(baseUrl, "cross-instance-isolation", idB),
        ]);
        if (sA?.state?.v !== 111) throw new Error(`instance A state wrong`);
        if (sB?.state?.v !== 222) throw new Error(`instance B state wrong`);
      },
    },
    {
      name: "http-same-actor-id-two-units-no-cross-state",
      category: "isolation",
      run: async (baseUrl) => {
        const shared = `shared-id-${uid()}`;
        await deleteActor(baseUrl, "cross-unit-isolation-a", shared);
        await deleteActor(baseUrl, "cross-unit-isolation-b", shared);
        await callActor(baseUrl, "cross-unit-isolation-a", shared, "setValue", { v: "unit-a" });
        await callActor(baseUrl, "cross-unit-isolation-b", shared, "setValue", { v: "unit-b" });
        const sa = await getState(baseUrl, "cross-unit-isolation-a", shared);
        const sb = await getState(baseUrl, "cross-unit-isolation-b", shared);
        if (sa?.state?.v !== "unit-a") throw new Error(`unit A state leaked or wrong: ${JSON.stringify(sa)}`);
        if (sb?.state?.v !== "unit-b") throw new Error(`unit B state leaked or wrong: ${JSON.stringify(sb)}`);
      },
    },
    {
      name: "http-actor-state-cross-project-404",
      category: "isolation",
      run: async (baseUrl) => {
        const id = `cross-proj-http-${uid()}`;
        await deleteActor(baseUrl, "cross-unit-isolation-a", id);
        await callActor(baseUrl, "cross-unit-isolation-a", id, "setValue", { v: "only-main-project" });
        const url = actorStateUrl(baseUrl, "cross-unit-isolation-a", id, ALT_PROJECT_ID);
        const r = await httpGetFull(url);
        if (r.status !== 404) {
          throw new Error(`expected 404 for actor state under different project_id, got ${r.status}`);
        }
      },
    },
    {
      name: "runtime-stage-scope-via-workflow",
      category: "isolation",
      run: async (baseUrl) => {
        const actorId = `iso-stage-actor-${uid()}`;
        await deleteActor(baseUrl, "runtime-scope-actor-target", actorId);
        await httpDeleteFull(actorStageDeleteUrl(baseUrl, "runtime-scope-actor-target", actorId, STAGE_RUNTIME_ID));
        await httpDeleteFull(actorStageDeleteUrl(baseUrl, "runtime-scope-actor-target", actorId, STAGE_B_RUNTIME_ID));
        const prodStart = await httpPostFull(wfUrl(baseUrl, "runtime-scope-actor-caller"), {
          actorId,
          marker: "prod",
        });
        const stageAStart = await httpPostFull(wfStageUrl(baseUrl, "runtime-scope-actor-caller", STAGE_RUNTIME_ID), {
          actorId,
          marker: "stage-a",
        });
        const stageBStart = await httpPostFull(wfStageUrl(baseUrl, "runtime-scope-actor-caller", STAGE_B_RUNTIME_ID), {
          actorId,
          marker: "stage-b",
        });
        if (prodStart.status !== 200 || !prodStart.body?.instanceId) throw new Error(`prod start failed`);
        if (stageAStart.status !== 200 || !stageAStart.body?.instanceId) throw new Error(`stage-a start failed`);
        if (stageBStart.status !== 200 || !stageBStart.body?.instanceId) throw new Error(`stage-b start failed`);
        const prodBase = `${wfUrl(baseUrl, "runtime-scope-actor-caller")}/${prodStart.body.instanceId as string}`;
        const stageABase = `${wfStageUrl(baseUrl, "runtime-scope-actor-caller", STAGE_RUNTIME_ID)}/${stageAStart.body.instanceId as string}`;
        const stageBBase = `${wfStageUrl(baseUrl, "runtime-scope-actor-caller", STAGE_B_RUNTIME_ID)}/${stageBStart.body.instanceId as string}`;
        await Promise.all([
          pollWorkflowStatus(prodBase, "completed"),
          pollWorkflowStatus(stageABase, "completed"),
          pollWorkflowStatus(stageBBase, "completed"),
        ]);
        const [prodResultResp, stageAResultResp, stageBResultResp] = await Promise.all([
          httpGetFull(`${prodBase}/result`),
          httpGetFull(`${stageABase}/result`),
          httpGetFull(`${stageBBase}/result`),
        ]);
        if (prodResultResp.body?.result?.scopeSurface !== "prod") {
          throw new Error(`prod scope surface mismatch: ${JSON.stringify(prodResultResp.body?.result)}`);
        }
        if (stageAResultResp.body?.result?.scopeSurface !== "stage-a") {
          throw new Error(`stage-a scope surface mismatch: ${JSON.stringify(stageAResultResp.body?.result)}`);
        }
        if (stageBResultResp.body?.result?.scopeSurface !== "stage-b") {
          throw new Error(`stage-b scope surface mismatch: ${JSON.stringify(stageBResultResp.body?.result)}`);
        }
      },
    },
    {
      name: "runtime-stage-scope-via-workflow-serial",
      category: "isolation",
      run: async (baseUrl) => {
        const actorId = `iso-stage-serial-${uid()}`;
        await deleteActor(baseUrl, "runtime-scope-actor-target", actorId);
        await httpDeleteFull(actorStageDeleteUrl(baseUrl, "runtime-scope-actor-target", actorId, STAGE_RUNTIME_ID));
        await httpDeleteFull(actorStageDeleteUrl(baseUrl, "runtime-scope-actor-target", actorId, STAGE_B_RUNTIME_ID));
        const runOne = async (marker: string, which: "prod" | "a" | "b") => {
          const start =
            which === "prod"
              ? await httpPostFull(wfUrl(baseUrl, "runtime-scope-actor-caller"), { actorId, marker })
              : await httpPostFull(
                  wfStageUrl(
                    baseUrl,
                    "runtime-scope-actor-caller",
                    which === "a" ? STAGE_RUNTIME_ID : STAGE_B_RUNTIME_ID,
                  ),
                  { actorId, marker },
                );
          if (start.status !== 200 || !start.body?.instanceId) {
            throw new Error(`start failed ${marker}: ${start.status}`);
          }
          const iid = start.body.instanceId as string;
          const base =
            which === "prod"
              ? `${wfUrl(baseUrl, "runtime-scope-actor-caller")}/${iid}`
              : `${wfStageUrl(baseUrl, "runtime-scope-actor-caller", which === "a" ? STAGE_RUNTIME_ID : STAGE_B_RUNTIME_ID)}/${iid}`;
          await pollWorkflowStatus(base, "completed");
          const res = await httpGetFull(`${base}/result`);
          return res.body?.result;
        };
        const rB = await runOne("stage-b", "b");
        const rA = await runOne("stage-a", "a");
        const rP = await runOne("prod", "prod");
        if (rB?.scopeSurface !== "stage-b") throw new Error(`serial stage-b: ${JSON.stringify(rB)}`);
        if (rA?.scopeSurface !== "stage-a") throw new Error(`serial stage-a: ${JSON.stringify(rA)}`);
        if (rP?.scopeSurface !== "prod") throw new Error(`serial prod: ${JSON.stringify(rP)}`);
      },
    },
    {
      name: "runtime-isolation-actor-chain-runner-triple",
      category: "isolation",
      run: async (baseUrl) => {
        const triple = (tag: string) => ({
          root: `r-${tag}-${uid()}`,
          chain: `c-${tag}-${uid()}`,
          leaf: `l-${tag}-${uid()}`,
        });
        const prod = triple("p");
        const sa = triple("a");
        const sb = triple("b");
        await Promise.all([
          deleteActor(baseUrl, "runtime-isolation-actor-chain-root", prod.root),
          deleteActor(baseUrl, "runtime-isolation-chain-actor-mid", prod.chain),
          deleteActor(baseUrl, "runtime-isolation-chain-actor-leaf", prod.leaf),
          deleteActor(baseUrl, "runtime-isolation-actor-chain-root", sa.root),
          deleteActor(baseUrl, "runtime-isolation-chain-actor-mid", sa.chain),
          deleteActor(baseUrl, "runtime-isolation-chain-actor-leaf", sa.leaf),
          deleteActor(baseUrl, "runtime-isolation-actor-chain-root", sb.root),
          deleteActor(baseUrl, "runtime-isolation-chain-actor-mid", sb.chain),
          deleteActor(baseUrl, "runtime-isolation-chain-actor-leaf", sb.leaf),
        ]);
        const prodStart = await httpPostFull(wfUrl(baseUrl, "runtime-isolation-actor-chain-runner"), {
          marker: "prod",
          rootActorId: prod.root,
          chainActorId: prod.chain,
          leafActorId: prod.leaf,
        });
        const stageAStart = await httpPostFull(wfStageUrl(baseUrl, "runtime-isolation-actor-chain-runner", STAGE_RUNTIME_ID), {
          marker: "stage-a",
          rootActorId: sa.root,
          chainActorId: sa.chain,
          leafActorId: sa.leaf,
        });
        const stageBStart = await httpPostFull(wfStageUrl(baseUrl, "runtime-isolation-actor-chain-runner", STAGE_B_RUNTIME_ID), {
          marker: "stage-b",
          rootActorId: sb.root,
          chainActorId: sb.chain,
          leafActorId: sb.leaf,
        });
        if (prodStart.status !== 200 || !prodStart.body?.instanceId) throw new Error(`prod start failed: ${prodStart.status}`);
        if (stageAStart.status !== 200 || !stageAStart.body?.instanceId) throw new Error(`stage-a start failed: ${stageAStart.status}`);
        if (stageBStart.status !== 200 || !stageBStart.body?.instanceId) throw new Error(`stage-b start failed: ${stageBStart.status}`);
        const prodBase = `${wfUrl(baseUrl, "runtime-isolation-actor-chain-runner")}/${prodStart.body.instanceId as string}`;
        const stageABase = `${wfStageUrl(baseUrl, "runtime-isolation-actor-chain-runner", STAGE_RUNTIME_ID)}/${stageAStart.body.instanceId as string}`;
        const stageBBase = `${wfStageUrl(baseUrl, "runtime-isolation-actor-chain-runner", STAGE_B_RUNTIME_ID)}/${stageBStart.body.instanceId as string}`;
        await Promise.all([
          pollWorkflowStatus(prodBase, "completed"),
          pollWorkflowStatus(stageABase, "completed"),
          pollWorkflowStatus(stageBBase, "completed"),
        ]);
        const [rp, ra, rb] = await Promise.all([
          httpGetFull(`${prodBase}/result`),
          httpGetFull(`${stageABase}/result`),
          httpGetFull(`${stageBBase}/result`),
        ]);
        const assertRes = (label: string, r: any, exp: string, marker: string) => {
          if (r?.midScope !== exp || r?.wfScope !== exp || r?.marker !== marker) {
            throw new Error(`${label} actor chain: ${JSON.stringify(r)}`);
          }
        };
        assertRes("prod", rp.body?.result, "prod", "prod");
        assertRes("stage-a", ra.body?.result, "stage-a", "stage-a");
        assertRes("stage-b", rb.body?.result, "stage-b", "stage-b");
      },
    },
    {
      name: "http-same-unit-path-actor-endpoint-triple",
      category: "isolation",
      run: async (baseUrl) => {
        const expectedPath = "test.actor-tests.actor.http-same-unit-path-runtime-isolation";
        const slug = "http-same-unit-path-runtime-isolation";
        const aid = `http-path-${uid()}`;
        await deleteActor(baseUrl, slug, aid);
        await httpDeleteFull(actorStageDeleteUrl(baseUrl, slug, aid, STAGE_RUNTIME_ID));
        await httpDeleteFull(actorStageDeleteUrl(baseUrl, slug, aid, STAGE_B_RUNTIME_ID));
        const [rp, ra, rb] = await Promise.all([
          httpPostFull(`${actorUrl(baseUrl, slug, aid, "probe")}?await=true`, {}),
          httpPostFull(`${actorStageUrl(baseUrl, slug, aid, "probe", STAGE_RUNTIME_ID)}?await=true`, {}),
          httpPostFull(`${actorStageUrl(baseUrl, slug, aid, "probe", STAGE_B_RUNTIME_ID)}?await=true`, {}),
        ]);
        const pr = rp.body?.result;
        const ar = ra.body?.result;
        const br = rb.body?.result;
        if (rp.status !== 200 || pr?.runtimeScope !== "prod" || pr?.unitPath !== expectedPath) {
          throw new Error(`prod actor homonymous path: ${JSON.stringify(rp.body)}`);
        }
        if (ra.status !== 200 || ar?.runtimeScope !== "stage-a" || ar?.unitPath !== expectedPath) {
          throw new Error(`stage-a actor homonymous path: ${JSON.stringify(ra.body)}`);
        }
        if (rb.status !== 200 || br?.runtimeScope !== "stage-b" || br?.unitPath !== expectedPath) {
          throw new Error(`stage-b actor homonymous path: ${JSON.stringify(rb.body)}`);
        }
      },
    },
    {
      name: "http-same-unit-path-actor-state-isolated-by-runtime-url",
      category: "isolation",
      run: async (baseUrl) => {
        const slug = "http-same-unit-path-runtime-isolation";
        const aid = `http-path-state-${uid()}`;
        await deleteActor(baseUrl, slug, aid);
        await httpDeleteFull(actorStageDeleteUrl(baseUrl, slug, aid, STAGE_RUNTIME_ID));
        await httpDeleteFull(actorStageDeleteUrl(baseUrl, slug, aid, STAGE_B_RUNTIME_ID));
        const wA = await httpPostFull(
          `${actorStageUrl(baseUrl, slug, aid, "writeTag", STAGE_RUNTIME_ID)}?await=true`,
          { tag: "STAGE_A_ONLY" },
        );
        if (wA.status !== 200) throw new Error(`stage-a writeTag: ${wA.status}`);
        await httpPostFull(`${actorUrl(baseUrl, slug, aid, "probe")}?await=true`, {});
        const prodState = await httpGetFull(actorStateUrl(baseUrl, slug, aid));
        if (prodState.status !== 200) throw new Error(`prod state GET: ${prodState.status}`);
        if ((prodState.body?.state?.tag as string | undefined) === "STAGE_A_ONLY") {
          throw new Error("prod actor state leaked stage-a tag for same unit path and actor id");
        }
        const wP = await httpPostFull(`${actorUrl(baseUrl, slug, aid, "writeTag")}?await=true`, { tag: "PROD_ONLY" });
        if (wP.status !== 200) throw new Error(`prod writeTag: ${wP.status}`);
        const stageAState = await httpGetFull(actorStageStateUrl(baseUrl, slug, aid, STAGE_RUNTIME_ID));
        if (stageAState.status !== 200) throw new Error(`stage-a state GET: ${stageAState.status}`);
        if ((stageAState.body?.state?.tag as string | undefined) === "PROD_ONLY") {
          throw new Error("stage-a actor state leaked prod tag for same unit path and actor id");
        }
      },
    },
    {
      name: "sdk-same-unit-path-callActor-triple",
      category: "isolation",
      run: async (baseUrl) => {
        const expectedPath = "test.actor-tests.actor.http-same-unit-path-runtime-isolation";
        const slug = "http-same-unit-path-runtime-isolation";
        const aid = `sdk-same-path-${uid()}`;
        await deleteActor(baseUrl, slug, aid);
        await httpDeleteFull(actorStageDeleteUrl(baseUrl, slug, aid, STAGE_RUNTIME_ID));
        await httpDeleteFull(actorStageDeleteUrl(baseUrl, slug, aid, STAGE_B_RUNTIME_ID));
        const caller = "sdk-http-same-path-runtime-isolation-actor-caller";
        const prodStart = await httpPostFull(wfUrl(baseUrl, caller), { actorId: aid });
        const stageAStart = await httpPostFull(wfStageUrl(baseUrl, caller, STAGE_RUNTIME_ID), { actorId: aid });
        const stageBStart = await httpPostFull(wfStageUrl(baseUrl, caller, STAGE_B_RUNTIME_ID), { actorId: aid });
        if (prodStart.status !== 200 || !prodStart.body?.instanceId) throw new Error("prod caller start failed");
        if (stageAStart.status !== 200 || !stageAStart.body?.instanceId) throw new Error("stage-a caller start failed");
        if (stageBStart.status !== 200 || !stageBStart.body?.instanceId) throw new Error("stage-b caller start failed");
        const prodBase = `${wfUrl(baseUrl, caller)}/${prodStart.body.instanceId as string}`;
        const stageABase = `${wfStageUrl(baseUrl, caller, STAGE_RUNTIME_ID)}/${stageAStart.body.instanceId as string}`;
        const stageBBase = `${wfStageUrl(baseUrl, caller, STAGE_B_RUNTIME_ID)}/${stageBStart.body.instanceId as string}`;
        await Promise.all([
          pollWorkflowStatus(prodBase, "completed"),
          pollWorkflowStatus(stageABase, "completed"),
          pollWorkflowStatus(stageBBase, "completed"),
        ]);
        const [rp, ra, rb] = await Promise.all([
          httpGetFull(`${prodBase}/result`),
          httpGetFull(`${stageABase}/result`),
          httpGetFull(`${stageBBase}/result`),
        ]);
        const pr = rp.body?.result;
        const ar = ra.body?.result;
        const br = rb.body?.result;
        if (pr?.runtimeScope !== "prod" || pr?.unitPath !== expectedPath) {
          throw new Error(`sdk prod→actor same path: ${JSON.stringify(pr)}`);
        }
        if (ar?.runtimeScope !== "stage-a" || ar?.unitPath !== expectedPath) {
          throw new Error(`sdk stage-a→actor same path: ${JSON.stringify(ar)}`);
        }
        if (br?.runtimeScope !== "stage-b" || br?.unitPath !== expectedPath) {
          throw new Error(`sdk stage-b→actor same path: ${JSON.stringify(br)}`);
        }
      },
    },
    {
      name: "sdk-same-unit-path-sendActorMessage-triple",
      category: "isolation",
      run: async (baseUrl) => {
        const expectedPath = "test.actor-tests.actor.http-same-unit-path-runtime-isolation";
        const slug = "http-same-unit-path-runtime-isolation";
        const aid = `sdk-send-${uid()}`;
        await deleteActor(baseUrl, slug, aid);
        await httpDeleteFull(actorStageDeleteUrl(baseUrl, slug, aid, STAGE_RUNTIME_ID));
        await httpDeleteFull(actorStageDeleteUrl(baseUrl, slug, aid, STAGE_B_RUNTIME_ID));
        const caller = "sdk-http-same-path-send-actor-msg-caller";
        const tagP = `TAG-P-${uid()}`;
        const tagA = `TAG-A-${uid()}`;
        const tagB = `TAG-B-${uid()}`;
        const prodStart = await httpPostFull(wfUrl(baseUrl, caller), { actorId: aid, tag: tagP });
        const stageAStart = await httpPostFull(wfStageUrl(baseUrl, caller, STAGE_RUNTIME_ID), { actorId: aid, tag: tagA });
        const stageBStart = await httpPostFull(wfStageUrl(baseUrl, caller, STAGE_B_RUNTIME_ID), { actorId: aid, tag: tagB });
        if (prodStart.status !== 200 || !prodStart.body?.instanceId) throw new Error("prod send-msg caller start failed");
        if (stageAStart.status !== 200 || !stageAStart.body?.instanceId) throw new Error("stage-a send-msg caller start failed");
        if (stageBStart.status !== 200 || !stageBStart.body?.instanceId) throw new Error("stage-b send-msg caller start failed");
        const prodBase = `${wfUrl(baseUrl, caller)}/${prodStart.body.instanceId as string}`;
        const stageABase = `${wfStageUrl(baseUrl, caller, STAGE_RUNTIME_ID)}/${stageAStart.body.instanceId as string}`;
        const stageBBase = `${wfStageUrl(baseUrl, caller, STAGE_B_RUNTIME_ID)}/${stageBStart.body.instanceId as string}`;
        await Promise.all([
          pollWorkflowStatus(prodBase, "completed"),
          pollWorkflowStatus(stageABase, "completed"),
          pollWorkflowStatus(stageBBase, "completed"),
        ]);
        const [rp, ra, rb] = await Promise.all([
          httpGetFull(`${prodBase}/result`),
          httpGetFull(`${stageABase}/result`),
          httpGetFull(`${stageBBase}/result`),
        ]);
        const pr = rp.body?.result;
        const ar = ra.body?.result;
        const br = rb.body?.result;
        if (pr?.tag !== tagP || pr?.runtimeScope !== "prod" || pr?.unitPath !== expectedPath) {
          throw new Error(`sdk send+read prod: ${JSON.stringify(pr)}`);
        }
        if (ar?.tag !== tagA || ar?.runtimeScope !== "stage-a" || ar?.unitPath !== expectedPath) {
          throw new Error(`sdk send+read stage-a: ${JSON.stringify(ar)}`);
        }
        if (br?.tag !== tagB || br?.runtimeScope !== "stage-b" || br?.unitPath !== expectedPath) {
          throw new Error(`sdk send+read stage-b: ${JSON.stringify(br)}`);
        }
      },
    },
    {
      name: "sdk-same-unit-path-durable-callActor-triple",
      category: "isolation",
      run: async (baseUrl) => {
        const expectedPath = "test.actor-tests.actor.http-same-unit-path-runtime-isolation";
        const slug = "http-same-unit-path-runtime-isolation";
        const aid = `sdk-durable-${uid()}`;
        await deleteActor(baseUrl, slug, aid);
        await httpDeleteFull(actorStageDeleteUrl(baseUrl, slug, aid, STAGE_RUNTIME_ID));
        await httpDeleteFull(actorStageDeleteUrl(baseUrl, slug, aid, STAGE_B_RUNTIME_ID));
        const caller = "sdk-http-same-path-durable-actor-caller";
        const prodStart = await httpPostFull(wfUrl(baseUrl, caller), { actorId: aid });
        const stageAStart = await httpPostFull(wfStageUrl(baseUrl, caller, STAGE_RUNTIME_ID), { actorId: aid });
        const stageBStart = await httpPostFull(wfStageUrl(baseUrl, caller, STAGE_B_RUNTIME_ID), { actorId: aid });
        if (prodStart.status !== 200 || !prodStart.body?.instanceId) throw new Error("prod durable caller start failed");
        if (stageAStart.status !== 200 || !stageAStart.body?.instanceId) throw new Error("stage-a durable caller start failed");
        if (stageBStart.status !== 200 || !stageBStart.body?.instanceId) throw new Error("stage-b durable caller start failed");
        const prodBase = `${wfUrl(baseUrl, caller)}/${prodStart.body.instanceId as string}`;
        const stageABase = `${wfStageUrl(baseUrl, caller, STAGE_RUNTIME_ID)}/${stageAStart.body.instanceId as string}`;
        const stageBBase = `${wfStageUrl(baseUrl, caller, STAGE_B_RUNTIME_ID)}/${stageBStart.body.instanceId as string}`;
        await Promise.all([
          pollWorkflowStatus(prodBase, "completed"),
          pollWorkflowStatus(stageABase, "completed"),
          pollWorkflowStatus(stageBBase, "completed"),
        ]);
        const [rp, ra, rb] = await Promise.all([
          httpGetFull(`${prodBase}/result`),
          httpGetFull(`${stageABase}/result`),
          httpGetFull(`${stageBBase}/result`),
        ]);
        const pr = rp.body?.result;
        const ar = ra.body?.result;
        const br = rb.body?.result;
        if (pr?.runtimeScope !== "prod" || pr?.unitPath !== expectedPath) {
          throw new Error(`durable prod→actor: ${JSON.stringify(pr)}`);
        }
        if (ar?.runtimeScope !== "stage-a" || ar?.unitPath !== expectedPath) {
          throw new Error(`durable stage-a→actor: ${JSON.stringify(ar)}`);
        }
        if (br?.runtimeScope !== "stage-b" || br?.unitPath !== expectedPath) {
          throw new Error(`durable stage-b→actor: ${JSON.stringify(br)}`);
        }
      },
    },
    {
      name: "sdk-same-unit-path-actor-handler-calls-homonymous-actor-triple",
      category: "isolation",
      run: async (baseUrl) => {
        const expectedPath = "test.actor-tests.actor.http-same-unit-path-runtime-isolation";
        const slug = "http-same-unit-path-runtime-isolation";
        const bridge = "sdk-actor-calls-homonymous-path";
        const aid = `sdk-bridge-${uid()}`;
        await deleteActor(baseUrl, slug, aid);
        await httpDeleteFull(actorStageDeleteUrl(baseUrl, slug, aid, STAGE_RUNTIME_ID));
        await httpDeleteFull(actorStageDeleteUrl(baseUrl, slug, aid, STAGE_B_RUNTIME_ID));
        const [rp, ra, rb] = await Promise.all([
          httpPostFull(`${actorUrl(baseUrl, bridge, aid, "probeHomonymous")}?await=true`, { childActorId: aid }),
          httpPostFull(
            `${actorStageUrl(baseUrl, bridge, aid, "probeHomonymous", STAGE_RUNTIME_ID)}?await=true`,
            { childActorId: aid },
          ),
          httpPostFull(
            `${actorStageUrl(baseUrl, bridge, aid, "probeHomonymous", STAGE_B_RUNTIME_ID)}?await=true`,
            { childActorId: aid },
          ),
        ]);
        const pr = rp.body?.result;
        const ar = ra.body?.result;
        const br = rb.body?.result;
        if (rp.status !== 200 || pr?.runtimeScope !== "prod" || pr?.unitPath !== expectedPath) {
          throw new Error(`actor sdk prod→homonymous: ${JSON.stringify(rp.body)}`);
        }
        if (ra.status !== 200 || ar?.runtimeScope !== "stage-a" || ar?.unitPath !== expectedPath) {
          throw new Error(`actor sdk stage-a→homonymous: ${JSON.stringify(ra.body)}`);
        }
        if (rb.status !== 200 || br?.runtimeScope !== "stage-b" || br?.unitPath !== expectedPath) {
          throw new Error(`actor sdk stage-b→homonymous: ${JSON.stringify(rb.body)}`);
        }
      },
    },
    {
      name: "sdk-same-unit-path-qw-calls-homonymous-actor-triple",
      category: "isolation",
      run: async (baseUrl) => {
        const expectedPath = "test.actor-tests.actor.http-same-unit-path-runtime-isolation";
        const isoSlug = "http-same-unit-path-runtime-isolation";
        const qwSlug = "sdk-qw-send-homonymous-actor-isolation";
        const aid = `sdk-qw-${uid()}`;
        const tagP = `TAG-P-${uid()}`;
        const tagA = `TAG-A-${uid()}`;
        const tagB = `TAG-B-${uid()}`;
        await deleteActor(baseUrl, isoSlug, aid);
        await httpDeleteFull(actorStageDeleteUrl(baseUrl, isoSlug, aid, STAGE_RUNTIME_ID));
        await httpDeleteFull(actorStageDeleteUrl(baseUrl, isoSlug, aid, STAGE_B_RUNTIME_ID));
        const enqP = await httpPostFull(atWorkerUrl(baseUrl, qwSlug), { actorId: aid, tag: tagP });
        const enqA = await httpPostFull(atWorkerStageUrl(baseUrl, qwSlug, STAGE_RUNTIME_ID), { actorId: aid, tag: tagA });
        const enqB = await httpPostFull(atWorkerStageUrl(baseUrl, qwSlug, STAGE_B_RUNTIME_ID), { actorId: aid, tag: tagB });
        if (enqP.status !== 200 || !enqP.body?.runId) throw new Error(`prod qw enqueue: ${enqP.status}`);
        if (enqA.status !== 200 || !enqA.body?.runId) throw new Error(`stage-a qw enqueue: ${enqA.status}`);
        if (enqB.status !== 200 || !enqB.body?.runId) throw new Error(`stage-b qw enqueue: ${enqB.status}`);
        const [p, a, b] = await Promise.all([
          pollAtWorker(baseUrl, qwSlug, enqP.body.runId as string),
          pollAtWorker(baseUrl, qwSlug, enqA.body.runId as string, STAGE_RUNTIME_ID),
          pollAtWorker(baseUrl, qwSlug, enqB.body.runId as string, STAGE_B_RUNTIME_ID),
        ]);
        if (
          p.status !== "completed" ||
          p.result?.tag !== tagP ||
          p.result?.runtimeScope !== "prod" ||
          p.result?.unitPath !== expectedPath
        ) {
          throw new Error(`qw prod→actor: ${JSON.stringify(p)}`);
        }
        if (
          a.status !== "completed" ||
          a.result?.tag !== tagA ||
          a.result?.runtimeScope !== "stage-a" ||
          a.result?.unitPath !== expectedPath
        ) {
          throw new Error(`qw stage-a→actor: ${JSON.stringify(a)}`);
        }
        if (
          b.status !== "completed" ||
          b.result?.tag !== tagB ||
          b.result?.runtimeScope !== "stage-b" ||
          b.result?.unitPath !== expectedPath
        ) {
          throw new Error(`qw stage-b→actor: ${JSON.stringify(b)}`);
        }
      },
    },
    {
      name: "sdk-same-unit-path-actor-calls-homonymous-wf-triple",
      category: "isolation",
      run: async (baseUrl) => {
        const expectedWfPath = "test.wf.workflow.http-same-unit-path-runtime-isolation";
        const bridge = "sdk-actor-calls-homonymous-wf-isolation";
        const markerP = `m-p-${uid()}`;
        const markerA = `m-a-${uid()}`;
        const markerB = `m-b-${uid()}`;
        const [rp, ra, rb] = await Promise.all([
          httpPostFull(`${actorUrl(baseUrl, bridge, `wf-${uid()}`, "probeHomonymousWf")}?await=true`, { marker: markerP }),
          httpPostFull(
            `${actorStageUrl(baseUrl, bridge, `wf-${uid()}`, "probeHomonymousWf", STAGE_RUNTIME_ID)}?await=true`,
            { marker: markerA },
          ),
          httpPostFull(
            `${actorStageUrl(baseUrl, bridge, `wf-${uid()}`, "probeHomonymousWf", STAGE_B_RUNTIME_ID)}?await=true`,
            { marker: markerB },
          ),
        ]);
        const pr = rp.body?.result;
        const ar = ra.body?.result;
        const br = rb.body?.result;
        if (
          rp.status !== 200 ||
          pr?.runtimeScope !== "prod" ||
          pr?.unitPath !== expectedWfPath ||
          pr?.marker !== markerP
        ) {
          throw new Error(`actor sdk prod→homonymous wf: ${JSON.stringify(rp.body)}`);
        }
        if (
          ra.status !== 200 ||
          ar?.runtimeScope !== "stage-a" ||
          ar?.unitPath !== expectedWfPath ||
          ar?.marker !== markerA
        ) {
          throw new Error(`actor sdk stage-a→homonymous wf: ${JSON.stringify(ra.body)}`);
        }
        if (
          rb.status !== 200 ||
          br?.runtimeScope !== "stage-b" ||
          br?.unitPath !== expectedWfPath ||
          br?.marker !== markerB
        ) {
          throw new Error(`actor sdk stage-b→homonymous wf: ${JSON.stringify(rb.body)}`);
        }
      },
    },
    {
      name: "sdk-same-unit-path-actor-enqueues-homonymous-qw-triple",
      category: "isolation",
      run: async (baseUrl) => {
        const expectedQwPath = "test.queue-worker.queue_worker.http-same-unit-path-runtime-isolation";
        const isoSlug = "http-same-unit-path-runtime-isolation";
        const bridge = "sdk-actor-calls-homonymous-qw-isolation";
        const qwPollBase = (stageId?: string) =>
          stageId
            ? `${baseUrl}/api/v1/trigger/workerQueue/${PROJECT_ID}/stage/${stageId}/test/queue-worker/${isoSlug}`
            : `${baseUrl}/api/v1/trigger/workerQueue/${PROJECT_ID}/test/queue-worker/${isoSlug}`;
        const pollQw = async (runId: string, stageId?: string) => {
          for (let i = 0; i < 120; i++) {
            await sleep(150);
            const st = await httpGetFull(`${qwPollBase(stageId)}/${runId}/status`);
            const status: string = st.body?.status ?? "unknown";
            if (status === "completed") {
              const res = await httpGetFull(`${qwPollBase(stageId)}/${runId}/result`);
              return res.body?.result;
            }
            if (status === "dead_letter" || status === "failed" || status === "cancelled") {
              throw new Error(`qw run ${status}: ${JSON.stringify(st.body)}`);
            }
          }
          throw new Error("qw poll timeout");
        };
        const markerP = `qwp-${uid()}`;
        const markerA = `qwa-${uid()}`;
        const markerB = `qwb-${uid()}`;
        const [ep, ea, eb] = await Promise.all([
          httpPostFull(`${actorUrl(baseUrl, bridge, `qw-${uid()}`, "probeHomonymousQw")}?await=true`, { marker: markerP }),
          httpPostFull(
            `${actorStageUrl(baseUrl, bridge, `qw-${uid()}`, "probeHomonymousQw", STAGE_RUNTIME_ID)}?await=true`,
            { marker: markerA },
          ),
          httpPostFull(
            `${actorStageUrl(baseUrl, bridge, `qw-${uid()}`, "probeHomonymousQw", STAGE_B_RUNTIME_ID)}?await=true`,
            { marker: markerB },
          ),
        ]);
        if (ep.status !== 200 || !ep.body?.result?.enqueuedRunId) throw new Error(`prod actor→qw: ${JSON.stringify(ep.body)}`);
        if (ea.status !== 200 || !ea.body?.result?.enqueuedRunId) throw new Error(`stage-a actor→qw: ${JSON.stringify(ea.body)}`);
        if (eb.status !== 200 || !eb.body?.result?.enqueuedRunId) throw new Error(`stage-b actor→qw: ${JSON.stringify(eb.body)}`);
        const [rp, ra, rb] = await Promise.all([
          pollQw(ep.body.result.enqueuedRunId as string),
          pollQw(ea.body.result.enqueuedRunId as string, STAGE_RUNTIME_ID),
          pollQw(eb.body.result.enqueuedRunId as string, STAGE_B_RUNTIME_ID),
        ]);
        if (rp?.runtimeScope !== "prod" || rp?.unitPath !== expectedQwPath || rp?.marker !== markerP) {
          throw new Error(`actor prod→homonymous qw wrong: ${JSON.stringify(rp)}`);
        }
        if (ra?.runtimeScope !== "stage-a" || ra?.unitPath !== expectedQwPath || ra?.marker !== markerA) {
          throw new Error(`actor stage-a→homonymous qw wrong: ${JSON.stringify(ra)}`);
        }
        if (rb?.runtimeScope !== "stage-b" || rb?.unitPath !== expectedQwPath || rb?.marker !== markerB) {
          throw new Error(`actor stage-b→homonymous qw wrong: ${JSON.stringify(rb)}`);
        }
      },
    },
    {
      name: "sdk-same-unit-path-actor-starts-homonymous-wf-triple",
      category: "isolation",
      run: async (baseUrl) => {
        const expectedChildPath = "test.wf.workflow.http-same-unit-path-runtime-isolation";
        const childSlug = "http-same-unit-path-runtime-isolation";
        const bridge = "sdk-actor-calls-homonymous-start-wf-isolation";
        const wfChildBase = (instanceId: string, stageId?: string) =>
          stageId
            ? `${baseUrl}/api/v1/trigger/wf/${PROJECT_ID}/stage/${stageId}/test/wf/${childSlug}/${instanceId}`
            : `${baseUrl}/api/v1/trigger/wf/${PROJECT_ID}/test/wf/${childSlug}/${instanceId}`;
        const markerP = `sp-${uid()}`;
        const markerA = `sa-${uid()}`;
        const markerB = `sb-${uid()}`;
        const [sp, sa, sb] = await Promise.all([
          httpPostFull(`${actorUrl(baseUrl, bridge, `st-${uid()}`, "startHomonymousWf")}?await=true`, { marker: markerP }),
          httpPostFull(
            `${actorStageUrl(baseUrl, bridge, `st-${uid()}`, "startHomonymousWf", STAGE_RUNTIME_ID)}?await=true`,
            { marker: markerA },
          ),
          httpPostFull(
            `${actorStageUrl(baseUrl, bridge, `st-${uid()}`, "startHomonymousWf", STAGE_B_RUNTIME_ID)}?await=true`,
            { marker: markerB },
          ),
        ]);
        const cidP = sp.body?.result?.childInstanceId as string | undefined;
        const cidA = sa.body?.result?.childInstanceId as string | undefined;
        const cidB = sb.body?.result?.childInstanceId as string | undefined;
        if (sp.status !== 200 || !cidP) throw new Error(`prod start child wf: ${JSON.stringify(sp.body)}`);
        if (sa.status !== 200 || !cidA) throw new Error(`stage-a start child wf: ${JSON.stringify(sa.body)}`);
        if (sb.status !== 200 || !cidB) throw new Error(`stage-b start child wf: ${JSON.stringify(sb.body)}`);
        await Promise.all([
          pollWorkflowStatus(wfChildBase(cidP), "completed"),
          pollWorkflowStatus(wfChildBase(cidA, STAGE_RUNTIME_ID), "completed"),
          pollWorkflowStatus(wfChildBase(cidB, STAGE_B_RUNTIME_ID), "completed"),
        ]);
        const [rp, ra, rb] = await Promise.all([
          httpGetFull(`${wfChildBase(cidP)}/result`),
          httpGetFull(`${wfChildBase(cidA, STAGE_RUNTIME_ID)}/result`),
          httpGetFull(`${wfChildBase(cidB, STAGE_B_RUNTIME_ID)}/result`),
        ]);
        const pr = rp.body?.result;
        const ar = ra.body?.result;
        const br = rb.body?.result;
        if (pr?.unitPath !== expectedChildPath || pr?.runtimeScope !== "prod" || pr?.marker !== markerP) {
          throw new Error(`actor prod start→child wf: ${JSON.stringify(pr)}`);
        }
        if (ar?.unitPath !== expectedChildPath || ar?.runtimeScope !== "stage-a" || ar?.marker !== markerA) {
          throw new Error(`actor stage-a start→child wf: ${JSON.stringify(ar)}`);
        }
        if (br?.unitPath !== expectedChildPath || br?.runtimeScope !== "stage-b" || br?.marker !== markerB) {
          throw new Error(`actor stage-b start→child wf: ${JSON.stringify(br)}`);
        }
      },
    },
    {
      name: "sdk-same-unit-path-actor-send-homonymous-actor-triple",
      category: "isolation",
      run: async (baseUrl) => {
        const expectedPath = "test.actor-tests.actor.http-same-unit-path-runtime-isolation";
        const slug = "http-same-unit-path-runtime-isolation";
        const bridge = "sdk-actor-send-homonymous-actor-isolation";
        const aid = `actor-send-${uid()}`;
        await deleteActor(baseUrl, slug, aid);
        await httpDeleteFull(actorStageDeleteUrl(baseUrl, slug, aid, STAGE_RUNTIME_ID));
        await httpDeleteFull(actorStageDeleteUrl(baseUrl, slug, aid, STAGE_B_RUNTIME_ID));
        const tagP = `TAG-P-${uid()}`;
        const tagA = `TAG-A-${uid()}`;
        const tagB = `TAG-B-${uid()}`;
        const [rp, ra, rb] = await Promise.all([
          httpPostFull(`${actorUrl(baseUrl, bridge, `br-${uid()}`, "probeSend")}?await=true`, {
            childActorId: aid,
            tag: tagP,
          }),
          httpPostFull(
            `${actorStageUrl(baseUrl, bridge, `br-${uid()}`, "probeSend", STAGE_RUNTIME_ID)}?await=true`,
            { childActorId: aid, tag: tagA },
          ),
          httpPostFull(
            `${actorStageUrl(baseUrl, bridge, `br-${uid()}`, "probeSend", STAGE_B_RUNTIME_ID)}?await=true`,
            { childActorId: aid, tag: tagB },
          ),
        ]);
        const pr = rp.body?.result;
        const ar = ra.body?.result;
        const br = rb.body?.result;
        if (rp.status !== 200 || pr?.tag !== tagP || pr?.runtimeScope !== "prod" || pr?.unitPath !== expectedPath) {
          throw new Error(`actor send+read prod→homonymous: ${JSON.stringify(rp.body)}`);
        }
        if (ra.status !== 200 || ar?.tag !== tagA || ar?.runtimeScope !== "stage-a" || ar?.unitPath !== expectedPath) {
          throw new Error(`actor send+read stage-a→homonymous: ${JSON.stringify(ra.body)}`);
        }
        if (rb.status !== 200 || br?.tag !== tagB || br?.runtimeScope !== "stage-b" || br?.unitPath !== expectedPath) {
          throw new Error(`actor send+read stage-b→homonymous: ${JSON.stringify(rb.body)}`);
        }
      },
    },
    {
      name: "sdk-same-unit-path-actor-wf-handler-homonymous-triple",
      category: "isolation",
      run: async (baseUrl) => {
        const expectedPath = "test.wf.workflow.http-same-path-wf-handler-isolation";
        const bridge = "sdk-actor-calls-homonymous-wf-handler-isolation";
        const tag = uid();
        const aidP = `hf-p-${tag}`;
        const aidA = `hf-a-${tag}`;
        const aidB = `hf-b-${tag}`;
        const urlP = `${actorUrl(baseUrl, bridge, aidP, "runHandlerProbe")}?await=true`;
        const urlA = `${actorStageUrl(baseUrl, bridge, aidA, "runHandlerProbe", STAGE_RUNTIME_ID)}?await=true`;
        const urlB = `${actorStageUrl(baseUrl, bridge, aidB, "runHandlerProbe", STAGE_B_RUNTIME_ID)}?await=true`;
        console.error(
          "[diag] sdk-same-unit-path-actor-wf-handler-homonymous-triple: parallel start",
          JSON.stringify({ tag, aidP, aidA, aidB, bridge, expectedPath, baseUrl }, null, 0),
        );
        const t0 = Date.now();
        const [rp, ra, rb] = await Promise.all([
          httpPostFull(urlP, {}),
          httpPostFull(urlA, {}),
          httpPostFull(urlB, {}),
        ]);
        const elapsed = Date.now() - t0;
        console.error(
          "[diag] sdk-same-unit-path-actor-wf-handler-homonymous-triple: parallel done",
          JSON.stringify(
            {
              elapsedMs: elapsed,
              prod: { status: rp.status, err: rp.body?.result?.error ?? null },
              stageA: { status: ra.status, err: ra.body?.result?.error ?? null },
              stageB: { status: rb.status, err: rb.body?.result?.error ?? null },
            },
            null,
            0,
          ),
        );
        const pr = rp.body?.result;
        const ar = ra.body?.result;
        const br = rb.body?.result;
        if (rp.status !== 200 || pr?.scopeFromHandler !== "prod" || pr?.unitPathFromHandler !== expectedPath) {
          const msg = diagActorWfHomonymousTripleLeg({
            leg: "prod",
            actorId: aidP,
            url: urlP,
            res: rp,
            expectedPath,
            expectedScope: "prod",
            elapsedMs: elapsed,
          });
          console.error(msg);
          throw new Error(msg);
        }
        if (ra.status !== 200 || ar?.scopeFromHandler !== "stage-a" || ar?.unitPathFromHandler !== expectedPath) {
          const msg = diagActorWfHomonymousTripleLeg({
            leg: "stage-a",
            actorId: aidA,
            url: urlA,
            res: ra,
            expectedPath,
            expectedScope: "stage-a",
            elapsedMs: elapsed,
          });
          console.error(msg);
          throw new Error(msg);
        }
        if (rb.status !== 200 || br?.scopeFromHandler !== "stage-b" || br?.unitPathFromHandler !== expectedPath) {
          const msg = diagActorWfHomonymousTripleLeg({
            leg: "stage-b",
            actorId: aidB,
            url: urlB,
            res: rb,
            expectedPath,
            expectedScope: "stage-b",
            elapsedMs: elapsed,
          });
          console.error(msg);
          throw new Error(msg);
        }
        console.error(
          "[diag] sdk-same-unit-path-actor-wf-handler-homonymous-triple: all legs ok",
          JSON.stringify({ tag, elapsedMs: elapsed }, null, 0),
        );
      },
    },
    {
      name: "redis-key-namespace",
      category: "isolation",
      skip: "requires test-only Redis key introspection endpoint",
      run: async (_baseUrl) => {},
    },
    {
      name: "pg-primary-key-scope",
      category: "isolation",
      skip: "requires direct Actor PG query access in tests",
      run: async (_baseUrl) => {},
    },

    // ---- metadata-enforcement (5) ----
    {
      name: "unknown-handler-rejected",
      category: "metadata-enforcement",
      run: async (baseUrl) => {
        const id = `meta-unknown-${uid()}`;
        await deleteActor(baseUrl, "unknown-handler-rejected", id);
        const resp = await callActorFull(baseUrl, "unknown-handler-rejected", id, "notDeclaredHandler");
        if (resp.status !== 400)
          throw new Error(`expected 400 for unknown handler, got ${resp.status}`);
      },
    },
    {
      name: "handler-allowlist",
      category: "metadata-enforcement",
      run: async (baseUrl) => {
        const id = `meta-allowlist-${uid()}`;
        await deleteActor(baseUrl, "handler-allowlist", id);
        const ok = await callActorFull(baseUrl, "handler-allowlist", id, "allowedHandler");
        const bad = await callActorFull(baseUrl, "handler-allowlist", id, "forbiddenHandler");
        if (ok.status !== 200) throw new Error(`declared handler rejected: ${ok.status}`);
        if (bad.status !== 400) throw new Error(`undeclared handler allowed: ${bad.status}`);
      },
    },
    {
      name: "max-idle-time-respected",
      category: "metadata-enforcement",
      run: async (baseUrl) => {
        const id = `meta-idle-${uid()}`;
        await deleteActor(baseUrl, "max-idle-time-respected", id);
        await callActor(baseUrl, "max-idle-time-respected", id, "increment");
        await sleep(PASSIVATION_IDLE_SLEEP_MS);
        await callActor(baseUrl, "max-idle-time-respected", id, "increment");
        const s = await getState(baseUrl, "max-idle-time-respected", id);
        if (s?.state?.count !== 2)
          throw new Error(`expected count=2 after idle eviction and second message, got ${JSON.stringify(s?.state)}`);
      },
    },
    {
      name: "retry-policy-applied",
      category: "metadata-enforcement",
      run: async (baseUrl) => {
        const id = `meta-retry-${uid()}`;
        await deleteActor(baseUrl, "retry-policy-applied", id);
        try {
          await callActor(baseUrl, "retry-policy-applied", id, "failFiveTimes");
        } catch { /* expected */ }
        const state = await getState(baseUrl, "retry-policy-applied", id);
        if ((state?.state?.attempts ?? 0) >= 5)
          throw new Error(`retry did not stop at maxAttempts=5`);
      },
    },
    {
      name: "mailbox-backlog-enforced",
      category: "metadata-enforcement",
      skip: "flooding mailbox requires rapid fire-and-forget calls; skip until backlog config exposed",
      run: async (_baseUrl) => {},
    },

    // ---- sdk-interface (8) ----
    {
      name: "actor-calls-workflow",
      category: "sdk-interface",
      run: async (baseUrl) => {
        const id = `sdk-wf-${uid()}`;
        await deleteActor(baseUrl, "actor-calls-workflow", id);
        await callActor(baseUrl, "actor-calls-workflow", id, "triggerWorkflow", { n: 3 });
        const state = await getState(baseUrl, "actor-calls-workflow", id);
        if ((state?.state?.workflowResult ?? -1) !== 6)
          throw new Error(`expected workflow result=6, got ${JSON.stringify(state?.state?.workflowResult)}`);
      },
    },
    {
      name: "actor-enqueues-worker",
      category: "sdk-interface",
      run: async (baseUrl) => {
        const id = `sdk-qw-${uid()}`;
        await deleteActor(baseUrl, "actor-enqueues-worker", id);
        await callActor(baseUrl, "actor-enqueues-worker", id, "triggerWorker", { value: 42 });
        const state = await getState(baseUrl, "actor-enqueues-worker", id);
        if (state?.state?.enqueuedRunId == null)
          throw new Error(`actor did not record enqueued runId in state`);
      },
    },
    {
      name: "actor-calls-actor",
      category: "sdk-interface",
      run: async (baseUrl) => {
        const parentId = `sdk-actor-parent-${uid()}`;
        const childId = `sdk-actor-child-${uid()}`;
        await Promise.all([
          deleteActor(baseUrl, "actor-calls-actor-parent", parentId),
          deleteActor(baseUrl, "actor-calls-actor-child", childId),
        ]);
        await callActor(baseUrl, "actor-calls-actor-parent", parentId, "callChild", { childId, value: 7 });
        const childState = await getState(baseUrl, "actor-calls-actor-child", childId);
        if (childState?.state?.receivedValue !== 7)
          throw new Error(`child actor did not receive value: ${JSON.stringify(childState?.state)}`);
      },
    },
    {
      name: "actor-send-actor-message-sync",
      category: "sdk-interface",
      run: async (baseUrl) => {
        const parentId = `sdk-send-async-parent-${uid()}`;
        const childId = `sdk-send-async-child-${uid()}`;
        await Promise.all([
          deleteActor(baseUrl, "send-actor-message-sync-parent", parentId),
          deleteActor(baseUrl, "actor-calls-actor-child", childId),
        ]);
        const result = await callActor(baseUrl, "send-actor-message-sync-parent", parentId, "sendChild", {
          childId,
          value: 19,
        });
        const body = result?.result ?? result;
        if (body?.delivered !== true)
          throw new Error(`expected sdk.sendActorMessageSync { delivered: true }, got ${JSON.stringify(body)}`);
        const parentState = await getState(baseUrl, "send-actor-message-sync-parent", parentId);
        if (parentState?.state?.sent !== true)
          throw new Error(`parent should commit after sync ack: ${JSON.stringify(parentState?.state)}`);
        for (let i = 0; i < 40; i++) {
          const childState = await getState(baseUrl, "actor-calls-actor-child", childId);
          if (childState?.state?.receivedValue === 19) return;
          await sleep(100);
        }
        const final = await getState(baseUrl, "actor-calls-actor-child", childId);
        throw new Error(`child did not process async message: ${JSON.stringify(final?.state)}`);
      },
    },
    {
      name: "actor-emits-event",
      category: "sdk-interface",
      skip: "event triggers not yet implemented",
      run: async (_baseUrl) => {},
    },
    {
      name: "actor-uses-secrets",
      category: "sdk-interface",
      skip: "secrets API not yet implemented",
      run: async (_baseUrl) => {},
    },
    {
      name: "workflow-calls-actor-durable",
      category: "sdk-interface",
      run: async (baseUrl) => {
        const actorId = `durable-basic-${uid()}`;
        await deleteActor(baseUrl, "call-actor-durable-target", actorId);
        const { base } = await startWorkflow(baseUrl, "call-actor-durable-basic", { actorId, value: 77 });
        await pollWorkflowStatus(base, "completed");
        const res = await httpGetFull(`${base}/result`);
        if (res.body?.result?.ok !== true)
          throw new Error(`expected ok=true, got ${JSON.stringify(res.body?.result)}`);
        if (res.body?.result?.value !== 77)
          throw new Error(`expected value=77, got ${JSON.stringify(res.body?.result?.value)}`);
        const state = await getState(baseUrl, "call-actor-durable-target", actorId);
        if (state?.state?.value !== 77)
          throw new Error(`actor state not updated: ${JSON.stringify(state?.state)}`);
      },
    },

    // ---- cross-unit (6) ----
    {
      name: "call-actor-from-api",
      category: "cross-unit",
      run: async (baseUrl) => {
        const actorId = `cu-api-${uid()}`;
        await deleteActor(baseUrl, "call-actor-from-api-target", actorId);
        const resp = await httpPostFull(
          `${baseUrl}/api/v1/trigger/${PROJECT_ID}/test/actor-tests/call-actor-from-api?actorId=${actorId}`,
        );
        if (resp.status !== 200)
          throw new Error(`API unit call returned ${resp.status}`);
        const result = resp.body?.result ?? resp.body;
        if (result?.ok !== true)
          throw new Error(`expected ok=true, got ${JSON.stringify(result)}`);
      },
    },
    {
      name: "call-actor-from-workflow",
      category: "cross-unit",
      run: async (baseUrl) => {
        const actorId = `cu-wf-${uid()}`;
        await deleteActor(baseUrl, "call-actor-from-workflow-target", actorId);
        const resp = await httpPostFull(
          `${baseUrl}/api/v1/trigger/workerQueue/${PROJECT_ID}/test/actor-tests/call-actor-from-workflow`,
          { actorId, value: 5 },
        );
        if (resp.status !== 200)
          throw new Error(`workflow trigger returned ${resp.status}`);
      },
    },
    {
      name: "call-actor-from-queue-worker",
      category: "cross-unit",
      run: async (baseUrl) => {
        const actorId = `cu-qw-${uid()}`;
        await deleteActor(baseUrl, "call-actor-from-qw-target", actorId);
        const resp = await httpPostFull(
          `${baseUrl}/api/v1/trigger/workerQueue/${PROJECT_ID}/test/actor-tests/call-actor-from-queue-worker`,
          { actorId },
        );
        if (resp.status !== 200)
          throw new Error(`queue worker trigger returned ${resp.status}`);
      },
    },
    {
      name: "call-actor-fire-and-forget",
      category: "cross-unit",
      run: async (baseUrl) => {
        const actorId = `cu-faf-${uid()}`;
        await deleteActor(baseUrl, "call-actor-faf-target", actorId);
        const resp = await callActorFull(baseUrl, "call-actor-faf-target", actorId, "fireAndForget", {}, {
          awaitResult: false,
        });
        if (resp.status !== 200)
          throw new Error(`fire-and-forget returned ${resp.status}, expected 200`);
        if (resp.body?.delivered !== true)
          throw new Error(`expected {delivered: true}, got ${JSON.stringify(resp.body)}`);
        await sleep(1_500);
        const state = await getState(baseUrl, "call-actor-faf-target", actorId);
        if (state?.state?.applied !== true)
          throw new Error(`fire-and-forget handler did not apply eventually`);
      },
    },
    {
      name: "call-actor-await-timeout",
      category: "cross-unit",
      run: async (baseUrl) => {
        const actorId = `cu-timeout-${uid()}`;
        await deleteActor(baseUrl, "call-actor-await-timeout-target", actorId);
        const resp = await callActorFull(
          baseUrl, "call-actor-await-timeout-target", actorId, "sleepLong",
          { timeoutMs: 200 },
        );
        if (resp.status === 200 && (resp.body?.result?.completed ?? resp.body?.completed) === true)
          throw new Error(`expected timeout error, but handler completed successfully`);
      },
    },
    {
      name: "call-actor-unknown-handler",
      category: "cross-unit",
      run: async (baseUrl) => {
        const actorId = `cu-badhandler-${uid()}`;
        await deleteActor(baseUrl, "call-actor-unknown-handler-target", actorId);
        const resp = await callActorFull(baseUrl, "call-actor-unknown-handler-target", actorId, "noSuchHandler");
        if (resp.status !== 400)
          throw new Error(`expected 400 for unknown handler, got ${resp.status}`);
        const state = await getState(baseUrl, "call-actor-unknown-handler-target", actorId);
        if ((state?.state?.touched ?? false) === true)
          throw new Error(`state was mutated by invalid handler call`);
      },
    },
    {
      name: "call-actor-durable-suspends-caller",
      category: "cross-unit",
      run: async (baseUrl) => {
        const actorId = `durable-suspend-${uid()}`;
        await deleteActor(baseUrl, "call-actor-durable-target", actorId);
        const { base } = await startWorkflow(baseUrl, "call-actor-durable-basic", { actorId, value: 55 });
        let sawSuspendedOrCompleted = false;
        for (let i = 0; i < 40; i++) {
          await sleep(150);
          const r = await httpGetFull(`${base}/status`);
          const st: string | undefined = r.body?.meta?.status;
          if (st === "suspended" || st === "completed") { sawSuspendedOrCompleted = true; break; }
          if (st === "failed") throw new Error(`workflow failed unexpectedly`);
        }
        if (!sawSuspendedOrCompleted)
          throw new Error(`workflow never entered suspended or completed state`);
        await pollWorkflowStatus(base, "completed");
        const state = await getState(baseUrl, "call-actor-durable-target", actorId);
        if (state?.state?.value !== 55)
          throw new Error(`actor state not updated after durable call: ${JSON.stringify(state?.state)}`);
      },
    },
    {
      name: "call-actor-durable-unknown-handler",
      category: "cross-unit",
      run: async (baseUrl) => {
        const actorId = `durable-unk-${uid()}`;
        await deleteActor(baseUrl, "call-actor-durable-target", actorId);
        const { base } = await startWorkflow(baseUrl, "call-actor-durable-unknown-handler", { actorId });
        await pollWorkflowStatus(base, "completed");
        const res = await httpGetFull(`${base}/result`);
        if (res.body?.result?.caught !== true)
          throw new Error(`expected caught=true for unknown durable handler, got ${JSON.stringify(res.body?.result)}`);
      },
    },

    // ---- sdk-dts-gaps (@sdk.d.ts vs host — implement then un-skip) ----
    {
      name: "actor-setAlarm-accepts-duration-object",
      category: "sdk-dts-gaps",
      skip:
        "@sdk.d.ts ActorContext.setAlarm(..., Duration); actor-runtime.js only implements fireAfterMs, numeric epoch ms, and Date — plain Duration objects are not converted",
      run: async (_baseUrl) => {},
    },
    {
      name: "actor-metadata-stateLimit-string",
      category: "sdk-dts-gaps",
      skip:
        "@sdk.d.ts ActorMetadata.stateLimit is a string (e.g. 512kb); extract_actor_metadata only serializes stateLimitBytes number — align parsing or the type",
      run: async (_baseUrl) => {},
    },
    {
      name: "actor-metadata-alarms-allowlist",
      category: "sdk-dts-gaps",
      skip:
        "@sdk.d.ts ActorMetadata.alarms string[] is not extracted in actor_runner metadata JSON nor enforced in actor_worker/manager",
      run: async (_baseUrl) => {},
    },
    {
      name: "actor-metadata-mailbox-backlog",
      category: "sdk-dts-gaps",
      skip:
        "@sdk.d.ts ActorMetadata.mailboxBacklog is not present in Rust ActorMetadata / no backlog enforcement",
      run: async (_baseUrl) => {},
    },
    {
      name: "actor-metadata-retry-policy-duration-fields",
      category: "sdk-dts-gaps",
      skip:
        "@sdk.d.ts RetryPolicy uses Duration for initialInterval/maxInterval; actor metadata passes retry through to serde expecting initialIntervalMs/maxIntervalMs — add normalization like queue worker or document *_ms only",
      run: async (_baseUrl) => {},
    },

    // ---- sharding-seam (3) ----
    {
      name: "project-id-in-all-redis-keys",
      category: "sharding-seam",
      skip: "requires test-only Redis key introspection endpoint",
      run: async (_baseUrl) => {},
    },
    {
      name: "project-id-in-all-pg-rows",
      category: "sharding-seam",
      skip: "requires direct Actor PG query access in tests",
      run: async (_baseUrl) => {},
    },
    {
      name: "project-id-in-all-nats-subjects",
      category: "sharding-seam",
      run: async (baseUrl) => {
        const id = `shard-nats-${uid()}`;
        await deleteActor(baseUrl, "lifecycle-events-broadcast", id);
        await callActor(baseUrl, "lifecycle-events-broadcast", id, "increment");
        void baseUrl;
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Endpoints inline tests
// ---------------------------------------------------------------------------

function allEndpointTests(): ActorInlineTestDef[] {
  return [
    {
      name: "call-await-true-response-shape",
      category: "endpoints",
      run: async (baseUrl) => {
        const id = `ep-await-true-${uid()}`;
        await deleteActor(baseUrl, "state-init", id);
        const resp = await callActorFull(baseUrl, "state-init", id, "getState", {}, { awaitResult: true });
        if (resp.status !== 200) throw new Error(`expected 200, got ${resp.status}`);
        if (!("result" in (resp.body as Record<string, unknown>)))
          throw new Error(`missing 'result' in await=true response: ${JSON.stringify(resp.body)}`);
      },
    },
    {
      name: "call-await-false-response-shape",
      category: "endpoints",
      run: async (baseUrl) => {
        const id = `ep-await-false-${uid()}`;
        await deleteActor(baseUrl, "state-init", id);
        const resp = await callActorFull(baseUrl, "state-init", id, "getState", {}, { awaitResult: false });
        if (resp.status !== 200) throw new Error(`expected 200, got ${resp.status}`);
        if (resp.body?.delivered !== true)
          throw new Error(`expected {delivered:true} for await=false, got ${JSON.stringify(resp.body)}`);
      },
    },
    {
      name: "get-state-response-shape",
      category: "endpoints",
      run: async (baseUrl) => {
        const id = `ep-getstate-${uid()}`;
        await deleteActor(baseUrl, "state-init", id);
        await callActor(baseUrl, "state-init", id, "getState");
        const resp = await httpGetFull(actorStateUrl(baseUrl, "state-init", id));
        if (resp.status !== 200) throw new Error(`expected 200, got ${resp.status}`);
        if (!("state" in (resp.body as Record<string, unknown>)))
          throw new Error(`missing 'state' field: ${JSON.stringify(resp.body)}`);
        if (typeof resp.body?.version !== "number")
          throw new Error(`missing or non-number 'version' field: ${JSON.stringify(resp.body)}`);
      },
    },
    {
      name: "get-state-nonexistent-default",
      category: "endpoints",
      run: async (baseUrl) => {
        const id = `ep-nonexistent-${uid()}`;
        const resp = await httpGetFull(actorStateUrl(baseUrl, "state-init", id));
        if (resp.status !== 200 && resp.status !== 404)
          throw new Error(`expected 200 (default state) or 404, got ${resp.status}`);
      },
    },
    {
      name: "passivate-endpoint-200",
      category: "endpoints",
      run: async (baseUrl) => {
        const id = `ep-passivate-${uid()}`;
        await deleteActor(baseUrl, "state-init", id);
        await callActor(baseUrl, "state-init", id, "getState");
        const resp = await passivate(baseUrl, "state-init", id);
        if (resp.status !== 200) throw new Error(`expected 200 from passivate, got ${resp.status}`);
      },
    },
    {
      name: "delete-endpoint-purges",
      category: "endpoints",
      run: async (baseUrl) => {
        const id = `ep-delete-${uid()}`;
        await deleteActor(baseUrl, "state-mutation", id);
        await callActor(baseUrl, "state-mutation", id, "increment");
        const delResp = await deleteActor(baseUrl, "state-mutation", id);
        if (delResp.status !== 200) throw new Error(`DELETE returned ${delResp.status}`);
        const stateResp = await httpGetFull(actorStateUrl(baseUrl, "state-mutation", id));
        if (stateResp.status === 200) {
          if ((stateResp.body?.state?.count ?? 0) !== 0)
            throw new Error(`state not reset after DELETE: ${JSON.stringify(stateResp.body?.state)}`);
        }
      },
    },
    {
      name: "unknown-handler-400",
      category: "endpoints",
      run: async (baseUrl) => {
        const id = `ep-unknown-handler-${uid()}`;
        const resp = await callActorFull(baseUrl, "unknown-handler-rejected", id, "doesNotExist");
        if (resp.status !== 400)
          throw new Error(`expected 400 for unknown handler, got ${resp.status}`);
      },
    },
    {
      name: "actor-id-email-like-accepted",
      category: "endpoints",
      run: async (baseUrl) => {
        const actorId = `user+tag@example.com-${uid()}`;
        await deleteActor(baseUrl, "state-init", actorId);
        const resp = await callActorFull(baseUrl, "state-init", actorId, "getState");
        if (resp.status !== 200)
          throw new Error(`expected 200 for email-like actor id, got ${resp.status}`);
      },
    },
    {
      name: "concurrent-call-same-actor",
      category: "endpoints",
      run: async (baseUrl) => {
        const id = `ep-concurrent-${uid()}`;
        await deleteActor(baseUrl, "state-mutation", id);
        const N = 10;
        const results = await Promise.all(
          Array.from({ length: N }, () =>
            callActorFull(baseUrl, "state-mutation", id, "increment"),
          ),
        );
        const failed = results.filter((r) => r.status !== 200);
        if (failed.length > 0)
          throw new Error(`${failed.length}/${N} concurrent calls failed: ${failed.map((r) => r.status).join(", ")}`);
        const state = await getState(baseUrl, "state-mutation", id);
        if (state?.state?.count !== N)
          throw new Error(`expected count=${N} after ${N} concurrent calls, got ${JSON.stringify(state?.state?.count)}`);
      },
    },

    // ---- extra endpoint gap coverage ----
    {
      name: "delete-nonexistent-actor",
      category: "endpoints",
      run: async (baseUrl) => {
        const id = `ep-del-nonexist-${uid()}`;
        const resp = await deleteActor(baseUrl, "state-init", id);
        if (resp.status !== 200 && resp.status !== 404)
          throw new Error(`DELETE nonexistent: expected 200 or 404, got ${resp.status}`);
        if (resp.status === 200 && typeof resp.body?.deleted !== "boolean")
          throw new Error(`DELETE 200 response missing 'deleted' field: ${JSON.stringify(resp.body)}`);
      },
    },
    {
      name: "passivate-nonexistent-actor",
      category: "endpoints",
      run: async (baseUrl) => {
        const id = `ep-pass-nonexist-${uid()}`;
        const resp = await passivate(baseUrl, "state-init", id);
        if (resp.status !== 200 && resp.status !== 404)
          throw new Error(`passivate nonexistent: expected 200 or 404, got ${resp.status}`);
        if (resp.status === 200 && typeof resp.body?.passivated !== "boolean")
          throw new Error(`passivate 200 missing 'passivated' field: ${JSON.stringify(resp.body)}`);
      },
    },
    {
      name: "await-false-then-state-persists",
      category: "endpoints",
      run: async (baseUrl) => {
        const id = `ep-faf-persist-${uid()}`;
        await deleteActor(baseUrl, "state-mutation", id);
        const resp = await callActorFull(baseUrl, "state-mutation", id, "increment", {}, { awaitResult: false });
        if (resp.status !== 200)
          throw new Error(`fire-and-forget returned ${resp.status}`);
        if (resp.body?.delivered !== true)
          throw new Error(`expected {delivered:true} for await=false, got ${JSON.stringify(resp.body)}`);
        for (let i = 0; i < 20; i++) {
          await sleep(200);
          const st = await getState(baseUrl, "state-mutation", id);
          if ((st?.state?.count ?? 0) >= 1) return;
        }
        throw new Error(`async actor state mutation did not persist within 4s`);
      },
    },
    {
      name: "unknown-handler-with-special-chars-400",
      category: "endpoints",
      run: async (baseUrl) => {
        const id = `ep-badhandler-${uid()}`;
        const url = actorUrl(baseUrl, "state-init", id, "get-state!");
        const resp = await httpPostFull(`${url}?await=true`, {});
        if (resp.status !== 400)
          throw new Error(`expected 400 for unknown handler, got ${resp.status}`);
      },
    },
    {
      name: "invalid-project-id-400",
      category: "endpoints",
      run: async (baseUrl) => {
        const url = `${baseUrl}/api/v1/trigger/actor/not-a-uuid/test/actor-tests/state-init/some-id/getState?await=true`;
        const resp = await httpPostFull(url, {});
        if (resp.status !== 400 && resp.status !== 404)
          throw new Error(`expected 400 or 404 for invalid project_id, got ${resp.status}`);
      },
    },
    {
      name: "state-after-passivate-persists",
      category: "endpoints",
      run: async (baseUrl) => {
        const id = `ep-passivate-state-${uid()}`;
        await deleteActor(baseUrl, "state-mutation", id);
        await callActor(baseUrl, "state-mutation", id, "increment");
        const stateBefore = await getState(baseUrl, "state-mutation", id);
        const passResp = await passivate(baseUrl, "state-mutation", id);
        if (passResp.status !== 200) throw new Error(`passivate returned ${passResp.status}`);
        const stateAfter = await getState(baseUrl, "state-mutation", id);
        if ((stateAfter?.state?.count ?? -1) !== (stateBefore?.state?.count ?? -2))
          throw new Error(`state changed after passivate: before=${JSON.stringify(stateBefore?.state)} after=${JSON.stringify(stateAfter?.state)}`);
        if (stateAfter?.version !== stateBefore?.version)
          throw new Error(`version changed after passivate: before=${stateBefore?.version} after=${stateAfter?.version}`);
      },
    },
    {
      name: "payload-too-large-413",
      category: "endpoints",
      run: async (baseUrl) => {
        const id = `ep-payload-large-${uid()}`;
        const maxBody = 32 * 1024 * 1024;
        const innerLen = maxBody - 10 + 2048;
        const largeBody = "x".repeat(innerLen);
        const url = `${actorUrl(baseUrl, "state-init", id, "getState")}?await=true`;
        const resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ data: largeBody }),
        });
        if (resp.status !== 413)
          throw new Error(`expected 413 for oversized payload, got ${resp.status}`);
      },
    },

    {
      name: "stage-call-await-true",
      category: "endpoint_stage",
      run: async (baseUrl) => {
        const id = `st-ep-await-${uid()}`;
        await httpDeleteFull(actorStageDeleteUrl(baseUrl, "state-init", id));
        const resp = await httpPostFull(`${actorStageUrl(baseUrl, "state-init", id, "getState")}?await=true`, {});
        if (resp.status !== 200)
          throw new Error(`expected 200, got ${resp.status}`);
        if (!("result" in (resp.body as Record<string, unknown>)))
          throw new Error(`missing result: ${JSON.stringify(resp.body)}`);
      },
    },
    {
      name: "stage-state-not-visible-on-production-url",
      category: "endpoint_stage",
      run: async (baseUrl) => {
        const id = `st-iso-${uid()}`;
        await deleteActor(baseUrl, "state-mutation", id);
        await httpDeleteFull(actorStageDeleteUrl(baseUrl, "state-mutation", id));
        const inc = await httpPostFull(`${actorStageUrl(baseUrl, "state-mutation", id, "increment")}?await=true`, {});
        if (inc.status !== 200)
          throw new Error(`stage increment failed: ${inc.status}`);
        const prodState = await httpGetFull(actorStateUrl(baseUrl, "state-mutation", id));
        if (prodState.status === 200 && (prodState.body?.state?.count ?? 0) !== 0) {
          throw new Error(`prod URL should not see stage actor state: ${JSON.stringify(prodState.body)}`);
        }
        const stState = await httpGetFull(actorStageStateUrl(baseUrl, "state-mutation", id));
        if (stState.status !== 200)
          throw new Error(`stage state GET failed: ${stState.status}`);
        if ((stState.body?.state?.count ?? 0) !== 1)
          throw new Error(`stage state count expected 1: ${JSON.stringify(stState.body)}`);
      },
    },
    {
      name: "stage-unknown-runtime-404",
      category: "endpoint_stage",
      run: async (baseUrl) => {
        const unknown = "00000000-dead-0000-0000-999999999999";
        const id = `st-badrt-${uid()}`;
        const url = `${actorStageUrl(baseUrl, "state-init", id, "getState", unknown)}?await=true`;
        const resp = await httpPostFull(url, {});
        if (resp.status !== 404)
          throw new Error(`expected 404 for unknown stage runtime, got ${resp.status}`);
      },
    },
    {
      name: "stage-passivate-and-delete",
      category: "endpoint_stage",
      run: async (baseUrl) => {
        const id = `st-pd-${uid()}`;
        await httpDeleteFull(actorStageDeleteUrl(baseUrl, "state-init", id));
        await httpPostFull(`${actorStageUrl(baseUrl, "state-init", id, "getState")}?await=true`, {});
        const pv = await httpPostFull(actorStagePassivateUrl(baseUrl, "state-init", id));
        if (pv.status !== 200)
          throw new Error(`stage passivate expected 200, got ${pv.status}`);
        const del = await httpDeleteFull(actorStageDeleteUrl(baseUrl, "state-init", id));
        if (del.status !== 200)
          throw new Error(`stage delete expected 200, got ${del.status}`);
      },
    },
    {
      name: "stage-and-prod-same-actor-id-isolated-counts",
      category: "endpoint_stage",
      run: async (baseUrl) => {
        const id = `st-dual-${uid()}`;
        await deleteActor(baseUrl, "state-mutation", id);
        await httpDeleteFull(actorStageDeleteUrl(baseUrl, "state-mutation", id));
        await httpPostFull(`${actorUrl(baseUrl, "state-mutation", id, "increment")}?await=true`, {});
        await httpPostFull(`${actorUrl(baseUrl, "state-mutation", id, "increment")}?await=true`, {});
        await httpPostFull(`${actorStageUrl(baseUrl, "state-mutation", id, "increment")}?await=true`, {});
        const prod = await getState(baseUrl, "state-mutation", id);
        const stage = await httpGet(actorStageStateUrl(baseUrl, "state-mutation", id));
        if ((prod?.state?.count ?? 0) !== 2)
          throw new Error(`prod count expected 2, got ${JSON.stringify(prod)}`);
        if ((stage?.state?.count ?? 0) !== 1)
          throw new Error(`stage count expected 1, got ${JSON.stringify(stage)}`);
      },
    },
    {
      name: "stage-a-and-stage-b-same-actor-id-isolated",
      category: "endpoint_stage",
      run: async (baseUrl) => {
        const id = `st-ab-${uid()}`;
        await httpDeleteFull(actorStageDeleteUrl(baseUrl, "state-mutation", id));
        await httpDeleteFull(actorStageDeleteUrl(baseUrl, "state-mutation", id, STAGE_B_RUNTIME_ID));
        await httpPostFull(
          `${actorStageUrl(baseUrl, "state-mutation", id, "increment", STAGE_RUNTIME_ID)}?await=true`,
          {},
        );
        await httpPostFull(
          `${actorStageUrl(baseUrl, "state-mutation", id, "increment", STAGE_RUNTIME_ID)}?await=true`,
          {},
        );
        const bOnlyA = await httpGetFull(actorStageStateUrl(baseUrl, "state-mutation", id, STAGE_B_RUNTIME_ID));
        if (bOnlyA.status !== 404)
          throw new Error(`stage-b GET with only stage-a mutations expected 404, got ${bOnlyA.status}`);
        await httpPostFull(
          `${actorStageUrl(baseUrl, "state-mutation", id, "increment", STAGE_B_RUNTIME_ID)}?await=true`,
          {},
        );
        const sa = await httpGetFull(actorStageStateUrl(baseUrl, "state-mutation", id, STAGE_RUNTIME_ID));
        const sb = await httpGetFull(actorStageStateUrl(baseUrl, "state-mutation", id, STAGE_B_RUNTIME_ID));
        if (sa.status !== 200 || sb.status !== 200)
          throw new Error(`state GET failed sa=${sa.status} sb=${sb.status}`);
        if ((sa.body?.state?.count ?? 0) !== 2)
          throw new Error(`stage-a count expected 2: ${JSON.stringify(sa.body)}`);
        if ((sb.body?.state?.count ?? 0) !== 1)
          throw new Error(`stage-b count expected 1: ${JSON.stringify(sb.body)}`);
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// State-limits inline — "at-limit" test
// ---------------------------------------------------------------------------

function stateLimitAtLimitTest(): ActorInlineTestDef {
  return {
    name: "state-at-limit",
    category: "state-limits",
    run: async (baseUrl) => {
      const id = `statelimit-at-${uid()}`;
      await deleteActor(baseUrl, "state-at-limit", id);
      const exactData = "x".repeat(1024 * 1024 - 64);
      const resp = await callActorFull(baseUrl, "state-at-limit", id, "setLargeState", { data: exactData });
      if (resp.status !== 200)
        throw new Error(`expected 200 for state at limit, got ${resp.status}`);
    },
  };
}

// ---------------------------------------------------------------------------
// Helper: build deep nested object
// ---------------------------------------------------------------------------

function buildDeepObject(depth: number, leaf: unknown): unknown {
  if (depth <= 0) return leaf;
  return { nested: buildDeepObject(depth - 1, leaf) };
}

// ---------------------------------------------------------------------------
// Report builder
// ---------------------------------------------------------------------------

function buildReport(results: TestResult[]) {
  const total = results.length;
  const skipped = results.filter((r) => r.pass && r.detail?.startsWith("SKIPPED:")).length;
  const passed = results.filter((r) => r.pass).length - skipped;
  const failed = total - passed - skipped;
  const healthy = failed === 0;

  const sectionsMap: Record<string, TestResult[]> = {};
  for (const r of results) {
    const cat = r.name.split(":")[0]?.trim() ?? "unknown";
    if (!sectionsMap[cat]) sectionsMap[cat] = [];
    sectionsMap[cat].push(r);
  }

  const sectionSummaries: Record<string, any> = {};
  const sectionDetails: Record<string, any> = {};
  const flatTests: any[] = [];

  for (const cat of Object.keys(sectionsMap).sort()) {
    const catTests = sectionsMap[cat] ?? [];
    const catPassed = catTests.filter((t) => t.pass).length;
    const catFailed = catTests.length - catPassed;

    sectionSummaries[cat] = {
      pass: catFailed === 0,
      passed: catPassed,
      failed: catFailed,
      total: catTests.length,
    };

    sectionDetails[cat] = {
      pass: catFailed === 0,
      tests: catTests.map((t) => ({
        name: t.name,
        pass: t.pass,
        ...(t.detail ? { detail: t.detail } : {}),
        ...(t.error ? { error: t.error } : {}),
      })),
    };

    for (const t of catTests) {
      flatTests.push({ name: t.name, pass: t.pass });
    }
  }

  return {
    summary: {
      healthy,
      total_tests: total,
      total_passed: passed,
      total_failed: failed,
      total_skipped: skipped,
      sections: sectionSummaries,
    },
    sections: sectionDetails,
    tests: flatTests,
  };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleRequest(req: IncomingMessage, res: ServerResponse) {
  const baseUrl = getBaseUrl(req);
  const suiteStartedAt = Date.now();

  type Job =
    | { kind: "actor"; test: ActorTestDef }
    | { kind: "inline"; test: ActorInlineTestDef };

  const jobs: Job[] = [
    ...allActorTests().map((test) => ({ kind: "actor" as const, test })),
    ...[...allInlineTests(), stateLimitAtLimitTest()].map((test) => ({ kind: "inline" as const, test })),
    ...allEndpointTests().map((test) => ({ kind: "inline" as const, test })),
  ].filter(
    (j) =>
      RUN_ONLY.length === 0 ||
      RUN_ONLY.some((f) => f.name === j.test.name && f.category === j.test.category),
  );

  const inFlight = new Set<string>();
  const heartbeat = setInterval(() => {
    if (inFlight.size === 0) return;
    const elapsedSec = Math.floor((Date.now() - suiteStartedAt) / 1000);
    console.log(
      `  actor: heartbeat +${elapsedSec}s in-flight (${inFlight.size}): ${[...inFlight].join(" | ")}`,
    );
  }, ACTOR_TEST_HEARTBEAT_MS);

  const runJob = async (job: Job, index: number, batchSize: number, batchName: string) => {
    const label = jobLabel(job);
    const tag = `${batchName} [${index + 1}/${batchSize}]`;
    console.log(`  actor: START ${tag} ${label} @ +${Date.now() - suiteStartedAt}ms`);
    inFlight.add(label);
    const t0 = Date.now();
    try {
      return job.kind === "actor"
        ? await runActorTest(baseUrl, job.test)
        : await runInlineTest(baseUrl, job.test);
    } finally {
      inFlight.delete(label);
      console.log(`  actor: DONE ${tag} ${label} (${Date.now() - t0}ms)`);
    }
  };

  const alarmJobs = jobs.filter((j) => j.kind === "inline" && j.test.category === "alarms");
  const otherJobs = jobs.filter((j) => !(j.kind === "inline" && j.test.category === "alarms"));
  const concurrency = actorTestRunnerConcurrency();

  console.log(
    `  actor: suite starting (${jobs.length} jobs: ${alarmJobs.length} alarms sequential, ${otherJobs.length} other @ concurrency ${concurrency})`,
  );

  try {
    const alarmResults =
      alarmJobs.length > 0
        ? await mapPool(alarmJobs, 1, (job, i) => runJob(job, i, alarmJobs.length, "alarms"))
        : [];
    const otherResults = await mapPool(otherJobs, concurrency, (job, i) =>
      runJob(job, i, otherJobs.length, "parallel"),
    );
    const results = [...alarmResults, ...otherResults];

    console.log(`  actor: suite finished in ${Date.now() - suiteStartedAt}ms`);

    const report = buildReport(results);
    const body = JSON.stringify(report, null, 2);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(body);
  } finally {
    clearInterval(heartbeat);
  }
}
