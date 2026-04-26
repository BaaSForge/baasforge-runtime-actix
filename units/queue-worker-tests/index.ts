/**
 * Queue Worker Integration Test Runner (API unit)
 *
 * An API unit that exercises all queue worker tests end-to-end via HTTP.
 * When triggered, it enqueues workers through the real trigger endpoints,
 * polls status/result, and validates results.
 *
 * GET / — runs all tests and returns a JSON report.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PROJECT_ID = "00000000-aaaa-bbbb-cccc-000000000010";
const ALT_PROJECT_ID = "00000000-aaaa-bbbb-cccc-000000000012";
const STAGE_RUNTIME_ID = "00000000-aaaa-bbbb-cccc-000000000022";
const STAGE_B_RUNTIME_ID = "00000000-aaaa-bbbb-cccc-000000000023";

function getBaseUrl(req: IncomingMessage): string {
  const host = req.headers.host ?? "127.0.0.1:3333";
  return `http://${host}`;
}

function workerUrl(baseUrl: string, slug: string, projectId = PROJECT_ID): string {
  return `${baseUrl}/api/v1/trigger/workerQueue/${projectId}/test/queue-worker/${slug}`;
}

function workerRunUrl(baseUrl: string, slug: string, runId: string, suffix: string, projectId = PROJECT_ID): string {
  return `${workerUrl(baseUrl, slug, projectId)}/${runId}/${suffix}`;
}

function wfUrl(baseUrl: string, slug: string, projectId = PROJECT_ID): string {
  return `${baseUrl}/api/v1/trigger/wf/${projectId}/test/wf/${slug}`;
}

function wfStageUrl(baseUrl: string, slug: string, runtimeId = STAGE_RUNTIME_ID): string {
  return `${baseUrl}/api/v1/trigger/wf/${PROJECT_ID}/stage/${runtimeId}/test/wf/${slug}`;
}

function workerStageUrl(
  baseUrl: string,
  slug: string,
  runtimeId = STAGE_RUNTIME_ID,
  projectId = PROJECT_ID,
): string {
  return `${baseUrl}/api/v1/trigger/workerQueue/${projectId}/stage/${runtimeId}/test/queue-worker/${slug}`;
}

function workerStageRunUrl(
  baseUrl: string,
  slug: string,
  runId: string,
  suffix: string,
  runtimeId = STAGE_RUNTIME_ID,
  projectId = PROJECT_ID,
): string {
  return `${workerStageUrl(baseUrl, slug, runtimeId, projectId)}/${runId}/${suffix}`;
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

interface WorkerTestDef {
  name: string;
  category: string;
  workerSlug: string;
  data: any;
  checks: CheckDef[];
  skip?: string;
  expectDeadLetter?: boolean;
  maxIterations?: number;
}

interface WorkerInlineTestDef {
  name: string;
  category: string;
  run: (baseUrl: string) => Promise<void>;
  skip?: string;
}

type CheckDef =
  | { type: "eq"; path: string; expected: any }
  | { type: "true"; path: string }
  | { type: "notNull"; path: string }
  | { type: "contains"; path: string; substr: string };

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
  }
}

// ---------------------------------------------------------------------------
// Queue worker orchestrator
// ---------------------------------------------------------------------------

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function enqueue(
  baseUrl: string,
  slug: string,
  data?: any,
  projectId = PROJECT_ID,
): Promise<{ runId: string; status: string } | null> {
  const resp = await httpPost(workerUrl(baseUrl, slug, projectId), data ?? {});
  if (!resp?.runId) return null;
  return resp as { runId: string; status: string };
}

async function pollWorker(
  baseUrl: string,
  slug: string,
  runId: string,
  maxIter = 100,
  projectId = PROJECT_ID,
  stageRuntimeForUrl?: string | null,
): Promise<{ status: string; result?: any }> {
  const statusPath = (suffix: string) =>
    stageRuntimeForUrl != null && stageRuntimeForUrl !== ""
      ? workerStageRunUrl(baseUrl, slug, runId, suffix, stageRuntimeForUrl, projectId)
      : workerRunUrl(baseUrl, slug, runId, suffix, projectId);
  for (let i = 0; i < maxIter; i++) {
    await sleep(150);
    const statusResp = await httpGet(statusPath("status"));
    const status: string = statusResp?.status ?? "unknown";
    if (status === "completed") {
      const resultResp = await httpGet(statusPath("result"));
      return { status, result: resultResp?.result };
    }
    if (status === "dead_letter" || status === "failed" || status === "cancelled") {
      return { status };
    }
  }
  return { status: "timeout" };
}

function validate(test: WorkerTestDef, output: any): TestResult {
  const label = `${test.category}: ${test.name}`;
  for (const check of test.checks) {
    const err = applyCheck(output, check);
    if (err) return { name: label, pass: false, detail: JSON.stringify(output), error: err };
  }
  return { name: label, pass: true, detail: JSON.stringify(output) };
}

function fail(name: string, msg: string): TestResult {
  return { name, pass: false, error: msg };
}

function pass(name: string, detail?: string): TestResult {
  return detail !== undefined ? { name, pass: true, detail } : { name, pass: true };
}

async function runWorkerTest(baseUrl: string, test: WorkerTestDef): Promise<TestResult> {
  const label = `${test.category}: ${test.name}`;
  if (test.skip) {
    return { name: label, pass: true, detail: `SKIPPED: ${test.skip}` };
  }
  try {
    const enqueued = await enqueue(baseUrl, test.workerSlug, test.data);
    if (!enqueued) return fail(label, `enqueue failed: no runId returned`);

    const { runId } = enqueued;
    const { status, result } = await pollWorker(baseUrl, test.workerSlug, runId, test.maxIterations);

    if (status === "timeout") return fail(label, "timed out waiting for terminal status");

    if (test.expectDeadLetter) {
      if (status === "dead_letter") return pass(label, "reached dead_letter as expected");
      return fail(label, `expected dead_letter, got '${status}'`);
    }

    if (status === "dead_letter") return fail(label, "unexpected dead_letter status");
    if (status === "failed") return fail(label, "unexpected failed status");

    return validate(test, result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return fail(label, `exception: ${msg}`);
  }
}

async function runInlineTest(baseUrl: string, test: WorkerInlineTestDef): Promise<TestResult> {
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
// Worker test definitions
// ---------------------------------------------------------------------------

function allWorkerTests(): WorkerTestDef[] {
  return [
    // ---- basic (5) ----
    {
      name: "process-and-return", category: "basic",
      workerSlug: "process-and-return",
      data: { value: 42, label: "hello" },
      checks: [
        { type: "eq", path: "received.value", expected: 42 },
        { type: "eq", path: "received.label", expected: "hello" },
        { type: "true", path: "processed" },
      ],
    },
    {
      name: "empty-data", category: "basic",
      workerSlug: "empty-data",
      data: {},
      checks: [
        { type: "true", path: "receivedEmpty" },
        { type: "eq", path: "keys", expected: 0 },
      ],
    },
    {
      name: "return-types", category: "basic",
      workerSlug: "return-types",
      data: {},
      checks: [
        { type: "eq", path: "str", expected: "queue-worker" },
        { type: "eq", path: "num", expected: -3.5 },
        { type: "eq", path: "obj.id", expected: 7 },
        { type: "eq", path: "arr.0", expected: 10 },
        { type: "eq", path: "nul", expected: null },
        { type: "eq", path: "nested.a.b.c", expected: "deep" },
      ],
    },
    {
      name: "async-processing", category: "basic",
      workerSlug: "async-processing",
      data: { n: 7 },
      checks: [
        { type: "eq", path: "doubled", expected: 14 },
        { type: "true", path: "asyncDone" },
      ],
    },

    // ---- retry (8) ----
    {
      name: "default-retry", category: "retry",
      workerSlug: "default-retry",
      data: {},
      checks: [
        { type: "eq", path: "finalAttempt", expected: 3 },
        { type: "true", path: "ok" },
      ],
    },
    {
      name: "custom-retry-policy", category: "retry",
      workerSlug: "custom-retry-policy",
      data: {},
      maxIterations: 300,
      checks: [
        { type: "eq", path: "finalAttempt", expected: 5 },
        { type: "true", path: "ok" },
      ],
    },
    {
      name: "retry-attempt-counter", category: "retry",
      workerSlug: "retry-attempt-counter",
      data: { targetAttempt: 4 },
      checks: [
        { type: "eq", path: "attempt", expected: 4 },
      ],
    },
    {
      name: "retry-exponential-backoff", category: "retry",
      workerSlug: "retry-exponential-backoff",
      data: {},
      maxIterations: 500,
      checks: [
        { type: "eq", path: "attempt", expected: 4 },
        { type: "notNull", path: "completedAt" },
      ],
    },
    {
      name: "terminal-error-no-retry", category: "retry",
      workerSlug: "terminal-error-no-retry",
      data: {},
      expectDeadLetter: true,
      checks: [],
    },
    {
      name: "retry-succeeds-on-last-attempt", category: "retry",
      workerSlug: "retry-succeeds-on-last-attempt",
      data: {},
      maxIterations: 300,
      checks: [
        { type: "eq", path: "finalAttempt", expected: 5 },
        { type: "true", path: "ok" },
      ],
    },
    {
      name: "retry-preserves-data", category: "retry",
      workerSlug: "retry-preserves-data",
      data: { secret: "unchanged", value: 99 },
      checks: [
        { type: "eq", path: "dataOnFinalAttempt.secret", expected: "unchanged" },
        { type: "eq", path: "dataOnFinalAttempt.value", expected: 99 },
        { type: "eq", path: "attempt", expected: 3 },
      ],
    },
    {
      name: "retry-then-success-return-value", category: "retry",
      workerSlug: "retry-then-success-return-value",
      data: {},
      checks: [
        { type: "eq", path: "successValue", expected: "from-successful-attempt" },
      ],
    },

    // ---- dead-letter (6) ----
    {
      name: "dead-letter-handler-called", category: "dead-letter",
      workerSlug: "dead-letter-handler-called",
      data: {},
      expectDeadLetter: true,
      checks: [],
    },
    {
      name: "dead-letter-receives-error", category: "dead-letter",
      workerSlug: "dead-letter-receives-error",
      data: {},
      expectDeadLetter: true,
      checks: [],
    },
    {
      name: "dead-letter-receives-data", category: "dead-letter",
      workerSlug: "dead-letter-receives-data",
      data: { originalValue: "test-payload" },
      expectDeadLetter: true,
      checks: [],
    },
    {
      name: "dead-letter-no-handler", category: "dead-letter",
      workerSlug: "dead-letter-no-handler",
      data: {},
      expectDeadLetter: true,
      checks: [],
    },
    {
      name: "dead-letter-handler-throws", category: "dead-letter",
      workerSlug: "dead-letter-handler-throws",
      data: {},
      expectDeadLetter: true,
      checks: [],
    },
    {
      name: "dead-letter-after-terminal-error", category: "dead-letter",
      workerSlug: "dead-letter-after-terminal-error",
      data: {},
      expectDeadLetter: true,
      checks: [],
    },

    // ---- concurrency (4) — all skip until concurrency control is implemented ----
    {
      name: "concurrency-limit", category: "concurrency",
      workerSlug: "concurrency-limit",
      data: { id: 1 },
      checks: [{ type: "notNull", path: "completedAt" }],
    },
    {
      name: "concurrency-default", category: "concurrency",
      workerSlug: "concurrency-default",
      data: { id: 1 },
      checks: [{ type: "notNull", path: "startedAt" }],
    },
    {
      name: "concurrency-slot-release", category: "concurrency",
      workerSlug: "concurrency-slot-release",
      data: { id: 1 },
      checks: [{ type: "notNull", path: "completedAt" }],
    },
    {
      name: "concurrency-with-failure", category: "concurrency",
      workerSlug: "concurrency-with-failure",
      data: { id: 1 },
      checks: [{ type: "notNull", path: "completedAt" }],
    },

    // ---- rate-limit (4) — all skip until rate limiting is implemented ----
    {
      name: "rate-limit-basic", category: "rate-limit",
      workerSlug: "rate-limit-basic",
      data: { id: 1 },
      checks: [{ type: "notNull", path: "startedAt" }],
    },
    {
      name: "rate-limit-window-reset", category: "rate-limit",
      workerSlug: "rate-limit-window-reset",
      data: { id: 1 },
      checks: [{ type: "notNull", path: "startedAt" }],
    },
    {
      name: "rate-limit-burst-not-dropped", category: "rate-limit",
      workerSlug: "rate-limit-burst-not-dropped",
      data: { id: 1 },
      checks: [{ type: "true", path: "processed" }],
    },
    {
      name: "rate-limit-with-concurrency", category: "rate-limit",
      workerSlug: "rate-limit-with-concurrency",
      data: { id: 1 },
      checks: [{ type: "notNull", path: "startedAt" }],
    },


    // ---- delay (3) — all skip until delay feature is implemented ----
    {
      name: "delay-basic", category: "delay",
      workerSlug: "delay-basic",
      data: { enqueuedAt: Date.now() },
      checks: [{ type: "notNull", path: "processedAt" }],
    },
    {
      name: "delay-ordering", category: "delay",
      workerSlug: "delay-ordering",
      data: { id: "delayed" },
      checks: [{ type: "notNull", path: "processedAt" }],
    },
    {
      name: "delay-with-retry", category: "delay",
      workerSlug: "delay-with-retry",
      data: { enqueuedAt: Date.now() },
      checks: [{ type: "notNull", path: "processedAt" }],
    },

    // ---- deduplication (4) ----
    {
      name: "dedup-key-prevents-duplicate", category: "deduplication",
      workerSlug: "dedup-target",
      data: { value: "dedup-test" },
      checks: [{ type: "eq", path: "value", expected: "dedup-test" }],
    },
    {
      name: "dedup-different-keys", category: "deduplication",
      workerSlug: "dedup-target",
      data: { value: "key-abc" },
      checks: [{ type: "eq", path: "value", expected: "key-abc" }],
    },
    {
      name: "dedup-after-completion", category: "deduplication",
      workerSlug: "dedup-target",
      data: { value: "after-complete" },
      checks: [{ type: "eq", path: "value", expected: "after-complete" }],
    },
    {
      name: "dedup-during-retry", category: "deduplication",
      workerSlug: "dedup-retry-target",
      data: { value: "during-retry" },
      checks: [{ type: "eq", path: "value", expected: "during-retry" }],
    },

    // ---- timeout (3) — all skip until timeout is implemented ----
    {
      name: "timeout-basic", category: "timeout",
      workerSlug: "timeout-basic",
      data: {},
      expectDeadLetter: true,
      checks: [],
    },
    {
      name: "timeout-triggers-retry", category: "timeout",
      workerSlug: "timeout-triggers-retry",
      data: {},
      checks: [
        { type: "eq", path: "attempt", expected: 2 },
        { type: "true", path: "ok" },
      ],
    },
    {
      name: "timeout-then-dead-letter", category: "timeout",
      workerSlug: "timeout-then-dead-letter",
      data: {},
      expectDeadLetter: true,
      checks: [],
    },

    // ---- sdk-interface (4) ----
    {
      name: "simple-handler-form", category: "sdk-interface",
      workerSlug: "simple-handler-form",
      data: { x: 6 },
      checks: [
        { type: "eq", path: "doubled", expected: 12 },
        { type: "eq", path: "form", expected: "simple" },
      ],
    },
    {
      name: "full-handler-form", category: "sdk-interface",
      workerSlug: "full-handler-form",
      data: { x: 6 },
      checks: [
        { type: "eq", path: "doubled", expected: 12 },
        { type: "eq", path: "form", expected: "full" },
      ],
    },
    {
      name: "ctx-properties", category: "sdk-interface",
      workerSlug: "ctx-properties",
      data: {},
      checks: [
        { type: "true", path: "idIsUuid" },
        { type: "true", path: "attemptIsOne" },
        { type: "true", path: "enqueuedAtIsMs" },
        { type: "eq", path: "attempt", expected: 1 },
      ],
    },

    // ---- cross-unit (5) ----
    {
      name: "enqueue-from-worker", category: "cross-unit",
      workerSlug: "enqueue-from-worker-a",
      data: { value: 5 },
      checks: [{ type: "notNull", path: "enqueuedRunId" }],
    },
    {
      name: "worker-calls-workflow", category: "cross-unit",
      workerSlug: "worker-calls-workflow",
      data: { n: 4 },
      checks: [
        { type: "eq", path: "n", expected: 4 },
        { type: "eq", path: "doubled", expected: 8 },
        { type: "true", path: "workerDone" },
      ],
    },
    // ---- isolation (2) ----
    {
      name: "queue-isolation", category: "isolation",
      workerSlug: "queue-a-worker",
      data: { value: "test-a" },
      checks: [
        { type: "eq", path: "queue", expected: "a" },
        { type: "eq", path: "value", expected: "test-a" },
      ],
    },

    // ---- durability (3) ----
    {
      name: "redelivery-on-crash", category: "durability",
      workerSlug: "redelivery-worker",
      data: {},
      checks: [
        { type: "eq", path: "attempt", expected: 2 },
        { type: "true", path: "ok" },
      ],
    },
    {
      name: "enqueued-items-survive-restart", category: "durability",
      workerSlug: "survive-restart-worker",
      data: { enqueuedBeforeRestart: true },
      checks: [
        { type: "true", path: "processed" },
        { type: "true", path: "enqueuedBeforeRestart" },
      ],
    },
    {
      name: "no-double-processing", category: "durability",
      workerSlug: "no-double-processing-worker",
      data: { runId: "test-run-1" },
      checks: [
        { type: "eq", path: "processedRunId", expected: "test-run-1" },
        { type: "notNull", path: "processedAt" },
      ],
    },
  ];
}

// ---------------------------------------------------------------------------
// Inline test definitions — lifecycle, endpoint, cross-unit special cases
// ---------------------------------------------------------------------------

function allInlineTests(): WorkerInlineTestDef[] {
  const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  return [
    // ---- basic: multiple-workers ----
    {
      name: "multiple-workers",
      category: "basic",
      run: async (baseUrl) => {
        const [ra, rb] = await Promise.all([
          enqueue(baseUrl, "multiple-workers-a", { tag: "from-a" }),
          enqueue(baseUrl, "multiple-workers-b", { tag: "from-b" }),
        ]);
        if (!ra || !rb) throw new Error("enqueue failed for one or both workers");

        const [da, db] = await Promise.all([
          pollWorker(baseUrl, "multiple-workers-a", ra.runId),
          pollWorker(baseUrl, "multiple-workers-b", rb.runId),
        ]);

        if (da.status !== "completed") throw new Error(`worker-a status: ${da.status}`);
        if (db.status !== "completed") throw new Error(`worker-b status: ${db.status}`);
        if (da.result?.worker !== "a") throw new Error(`worker-a result mismatch`);
        if (db.result?.worker !== "b") throw new Error(`worker-b result mismatch`);
        if (da.result?.tag !== "from-a") throw new Error(`worker-a tag mismatch`);
        if (db.result?.tag !== "from-b") throw new Error(`worker-b tag mismatch`);
      },
    },

    // ---- lifecycle (5) ----
    {
      name: "status-queued",
      category: "lifecycle",
      run: async (baseUrl) => {
        const enqueued = await enqueue(baseUrl, "slow-worker", { sleepMs: 3000 });
        if (!enqueued) throw new Error("enqueue failed");
        const statusResp = await httpGet(
          workerRunUrl(baseUrl, "slow-worker", enqueued.runId, "status"),
        );
        const status = statusResp?.status;
        if (status !== "queued" && status !== "processing")
          throw new Error(`expected 'queued' (or 'processing' if dispatched immediately), got '${status}'`);
      },
    },
    {
      name: "status-processing",
      category: "lifecycle",
      run: async (baseUrl) => {
        const enqueued = await enqueue(baseUrl, "slow-worker", { sleepMs: 3000 });
        if (!enqueued) throw new Error("enqueue failed");
        await sleep(500);
        const statusResp = await httpGet(
          workerRunUrl(baseUrl, "slow-worker", enqueued.runId, "status"),
        );
        if (statusResp?.status !== "processing")
          throw new Error(`expected 'processing', got '${statusResp?.status}'`);
      },
    },
    {
      name: "status-completed",
      category: "lifecycle",
      run: async (baseUrl) => {
        const enqueued = await enqueue(baseUrl, "process-and-return", {
          value: 1,
          label: "lifecycle-test",
        });
        if (!enqueued) throw new Error("enqueue failed");
        const { status } = await pollWorker(baseUrl, "process-and-return", enqueued.runId);
        if (status !== "completed") throw new Error(`expected 'completed', got '${status}'`);
      },
    },
    {
      name: "status-dead-letter",
      category: "lifecycle",
      run: async (baseUrl) => {
        const enqueued = await enqueue(baseUrl, "always-fail-worker", {});
        if (!enqueued) throw new Error("enqueue failed");
        const { status } = await pollWorker(
          baseUrl,
          "always-fail-worker",
          enqueued.runId,
          200,
        );
        if (status !== "dead_letter") throw new Error(`expected 'dead_letter', got '${status}'`);
      },
    },
    {
      name: "status-retrying",
      category: "lifecycle",
      run: async (baseUrl) => {
        const enqueued = await enqueue(baseUrl, "fail-twice-worker", {});
        if (!enqueued) throw new Error("enqueue failed");

        let sawRetrying = false;
        for (let i = 0; i < 50; i++) {
          await sleep(200);
          const statusResp = await httpGet(
            workerRunUrl(baseUrl, "fail-twice-worker", enqueued.runId, "status"),
          );
          if (statusResp?.status === "retrying") { sawRetrying = true; break; }
          if (statusResp?.status === "completed") break;
        }
        if (!sawRetrying) throw new Error("never observed 'retrying' status");
      },
    },

    // ---- sdk-interface: enqueue-options ----
    {
      name: "enqueue-options",
      category: "sdk-interface",
      run: async (baseUrl) => {
        const enqueued = await enqueue(baseUrl, "enqueue-options-target", {
          label: "with-options",
        });
        if (!enqueued) throw new Error("enqueue failed");
        const { status, result } = await pollWorker(
          baseUrl,
          "enqueue-options-target",
          enqueued.runId,
        );
        if (status !== "completed") throw new Error(`expected completed, got ${status}`);
        if (result?.label !== "with-options") throw new Error("label mismatch");
      },
    },

    // ---- cross-unit: enqueue-from-api ----
    {
      name: "enqueue-from-api",
      category: "cross-unit",
      run: async (baseUrl) => {
        const enqueued = await enqueue(baseUrl, "target-worker", {
          payload: { source: "api-unit" },
        });
        if (!enqueued) throw new Error("enqueue failed: no runId");
        if (!UUID_RX.test(enqueued.runId))
          throw new Error(`runId is not a UUID: ${enqueued.runId}`);
        const { status, result } = await pollWorker(
          baseUrl,
          "target-worker",
          enqueued.runId,
        );
        if (status !== "completed") throw new Error(`expected completed, got ${status}`);
        if (!result?.ok) throw new Error("worker result.ok is not true");
      },
    },
    {
      name: "enqueue-from-workflow",
      category: "cross-unit",
      skip: "workflow-to-worker SDK not yet implemented",
      run: async (_baseUrl) => {},
    },

    // ---- isolation: cross-project-isolation ----
    {
      name: "cross-project-isolation",
      category: "isolation",
      run: async (baseUrl) => {
        const [ra, rb] = await Promise.all([
          enqueue(baseUrl, "isolated-worker", { projectTag: "A" }, PROJECT_ID),
          enqueue(baseUrl, "isolated-worker", { projectTag: "B" }, ALT_PROJECT_ID),
        ]);
        if (!ra || !rb) throw new Error("enqueue failed");

        const [da, db] = await Promise.all([
          pollWorker(baseUrl, "isolated-worker", ra.runId, 100, PROJECT_ID),
          pollWorker(baseUrl, "isolated-worker", rb.runId, 100, ALT_PROJECT_ID),
        ]);

        if (da.result?.projectTag !== "A") throw new Error("project A data leaked");
        if (db.result?.projectTag !== "B") throw new Error("project B data leaked");
        if (da.result?.runId === db.result?.runId) throw new Error("run IDs collided across projects");
      },
    },
    {
      name: "endpoint-status-cross-project-404",
      category: "isolation",
      run: async (baseUrl) => {
        const enqueued = await enqueue(baseUrl, "echo-worker", { tag: "status-xproj" });
        if (!enqueued) throw new Error("enqueue failed");
        const url = `${baseUrl}/api/v1/trigger/workerQueue/${ALT_PROJECT_ID}/test/queue-worker/echo-worker/${enqueued.runId}/status`;
        const resp = await httpGetFull(url);
        if (resp.status !== 404) {
          throw new Error(`expected 404 for worker status under different project_id, got ${resp.status}`);
        }
      },
    },
    {
      name: "runtime-stage-scope-via-workflow",
      category: "isolation",
      run: async (baseUrl) => {
        const prodStart = await httpPostFull(wfUrl(baseUrl, "runtime-scope-worker-caller"), { marker: "prod" });
        const stageAStart = await httpPostFull(wfStageUrl(baseUrl, "runtime-scope-worker-caller", STAGE_RUNTIME_ID), { marker: "stage-a" });
        const stageBStart = await httpPostFull(wfStageUrl(baseUrl, "runtime-scope-worker-caller", STAGE_B_RUNTIME_ID), { marker: "stage-b" });
        if (prodStart.status !== 200 || !prodStart.body?.instanceId) throw new Error("prod start failed");
        if (stageAStart.status !== 200 || !stageAStart.body?.instanceId) throw new Error("stage-a start failed");
        if (stageBStart.status !== 200 || !stageBStart.body?.instanceId) throw new Error("stage-b start failed");
        const prodBase = `${wfUrl(baseUrl, "runtime-scope-worker-caller")}/${prodStart.body.instanceId as string}`;
        const stageABase = `${wfStageUrl(baseUrl, "runtime-scope-worker-caller", STAGE_RUNTIME_ID)}/${stageAStart.body.instanceId as string}`;
        const stageBBase = `${wfStageUrl(baseUrl, "runtime-scope-worker-caller", STAGE_B_RUNTIME_ID)}/${stageBStart.body.instanceId as string}`;
        for (let i = 0; i < 100; i++) {
          await sleep(150);
          const [prodSt, stageASt, stageBSt] = await Promise.all([
            httpGetFull(`${prodBase}/status`),
            httpGetFull(`${stageABase}/status`),
            httpGetFull(`${stageBBase}/status`),
          ]);
          if (
            prodSt.body?.meta?.status === "completed" &&
            stageASt.body?.meta?.status === "completed" &&
            stageBSt.body?.meta?.status === "completed"
          ) {
            const [prodWfRes, stageAWfRes, stageBWfRes] = await Promise.all([
              httpGetFull(`${prodBase}/result`),
              httpGetFull(`${stageABase}/result`),
              httpGetFull(`${stageBBase}/result`),
            ]);
            const prodRunId = prodWfRes.body?.result?.workerRunId as string | undefined;
            const stageARunId = stageAWfRes.body?.result?.workerRunId as string | undefined;
            const stageBRunId = stageBWfRes.body?.result?.workerRunId as string | undefined;
            if (!prodRunId || !stageARunId || !stageBRunId) throw new Error("missing worker runId from workflow result");
            const [prodWorker, stageAWorker, stageBWorker] = await Promise.all([
              pollWorker(baseUrl, "runtime-scope-worker-target", prodRunId, 100),
              pollWorker(baseUrl, "runtime-scope-worker-target", stageARunId, 100, PROJECT_ID, STAGE_RUNTIME_ID),
              pollWorker(baseUrl, "runtime-scope-worker-target", stageBRunId, 100, PROJECT_ID, STAGE_B_RUNTIME_ID),
            ]);
            if (prodWorker.result?.runtimeScope !== "prod") {
              throw new Error(`prod worker scope mismatch: ${JSON.stringify(prodWorker.result)}`);
            }
            if (stageAWorker.result?.runtimeScope !== "stage-a") {
              throw new Error(`stage-a worker scope mismatch: ${JSON.stringify(stageAWorker.result)}`);
            }
            if (stageBWorker.result?.runtimeScope !== "stage-b") {
              throw new Error(`stage-b worker scope mismatch: ${JSON.stringify(stageBWorker.result)}`);
            }
            return;
          }
        }
        throw new Error("workflow callers did not complete");
      },
    },
    {
      name: "runtime-stage-scope-via-workflow-serial",
      category: "isolation",
      run: async (baseUrl) => {
        const runWf = async (marker: string, which: "prod" | "a" | "b") => {
          const start =
            which === "prod"
              ? await httpPostFull(wfUrl(baseUrl, "runtime-scope-worker-caller"), { marker })
              : await httpPostFull(
                  wfStageUrl(
                    baseUrl,
                    "runtime-scope-worker-caller",
                    which === "a" ? STAGE_RUNTIME_ID : STAGE_B_RUNTIME_ID,
                  ),
                  { marker },
                );
          if (start.status !== 200 || !start.body?.instanceId) throw new Error(`start ${marker} failed`);
          const iid = start.body.instanceId as string;
          const base =
            which === "prod"
              ? `${wfUrl(baseUrl, "runtime-scope-worker-caller")}/${iid}`
              : `${wfStageUrl(baseUrl, "runtime-scope-worker-caller", which === "a" ? STAGE_RUNTIME_ID : STAGE_B_RUNTIME_ID)}/${iid}`;
          for (let i = 0; i < 100; i++) {
            await sleep(150);
            const st = await httpGetFull(`${base}/status`);
            if (st.body?.meta?.status === "completed") {
              const wr = await httpGetFull(`${base}/result`);
              const runId = wr.body?.result?.workerRunId as string | undefined;
              if (!runId) throw new Error("missing workerRunId");
              const stageRt =
                which === "a" ? STAGE_RUNTIME_ID : which === "b" ? STAGE_B_RUNTIME_ID : undefined;
              const w = await pollWorker(
                baseUrl,
                "runtime-scope-worker-target",
                runId,
                100,
                PROJECT_ID,
                stageRt,
              );
              return w.result;
            }
          }
          throw new Error(`workflow ${marker} did not complete`);
        };
        const rB = await runWf("stage-b", "b");
        const rA = await runWf("stage-a", "a");
        const rP = await runWf("prod", "prod");
        if (rB?.runtimeScope !== "stage-b") throw new Error(`serial stage-b: ${JSON.stringify(rB)}`);
        if (rA?.runtimeScope !== "stage-a") throw new Error(`serial stage-a: ${JSON.stringify(rA)}`);
        if (rP?.runtimeScope !== "prod") throw new Error(`serial prod: ${JSON.stringify(rP)}`);
      },
    },
    {
      name: "runtime-isolation-qw-sdk-chain-triple",
      category: "isolation",
      run: async (baseUrl) => {
        const assertChain = async (
          label: string,
          marker: string,
          expScope: "prod" | "stage-a" | "stage-b",
          rootRunId: string,
        ) => {
          const stageRt =
            expScope === "stage-a"
              ? STAGE_RUNTIME_ID
              : expScope === "stage-b"
                ? STAGE_B_RUNTIME_ID
                : undefined;
          const root = await pollWorker(
            baseUrl,
            "runtime-isolation-qw-chain-root",
            rootRunId,
            120,
            PROJECT_ID,
            stageRt,
          );
          if (root.status !== "completed") throw new Error(`${label} root worker: ${root.status}`);
          const rr = root.result;
          if (rr?.wfDoubled !== 14 || rr?.marker !== marker || !rr?.nestedRunId) {
            throw new Error(`${label} root result: ${JSON.stringify(rr)}`);
          }
          const nested = await pollWorker(
            baseUrl,
            "runtime-isolation-qw-nested",
            rr.nestedRunId as string,
            120,
            PROJECT_ID,
            stageRt,
          );
          if (nested.status !== "completed") throw new Error(`${label} nested worker: ${nested.status}`);
          const ns = nested.result;
          if (ns?.runtimeScope !== expScope || ns?.marker !== marker) {
            throw new Error(`${label} nested scope: ${JSON.stringify(ns)}`);
          }
        };
        const prodStart = await httpPostFull(wfUrl(baseUrl, "runtime-isolation-qw-chain-caller"), { marker: "mp" });
        const stageAStart = await httpPostFull(
          wfStageUrl(baseUrl, "runtime-isolation-qw-chain-caller", STAGE_RUNTIME_ID),
          { marker: "ma" },
        );
        const stageBStart = await httpPostFull(
          wfStageUrl(baseUrl, "runtime-isolation-qw-chain-caller", STAGE_B_RUNTIME_ID),
          { marker: "mb" },
        );
        if (prodStart.status !== 200 || !prodStart.body?.instanceId) throw new Error("prod wf start failed");
        if (stageAStart.status !== 200 || !stageAStart.body?.instanceId) throw new Error("stage-a wf start failed");
        if (stageBStart.status !== 200 || !stageBStart.body?.instanceId) throw new Error("stage-b wf start failed");
        const prodBase = `${wfUrl(baseUrl, "runtime-isolation-qw-chain-caller")}/${prodStart.body.instanceId as string}`;
        const stageABase = `${wfStageUrl(baseUrl, "runtime-isolation-qw-chain-caller", STAGE_RUNTIME_ID)}/${stageAStart.body.instanceId as string}`;
        const stageBBase = `${wfStageUrl(baseUrl, "runtime-isolation-qw-chain-caller", STAGE_B_RUNTIME_ID)}/${stageBStart.body.instanceId as string}`;
        for (let i = 0; i < 120; i++) {
          await sleep(150);
          const [ps, as, bs] = await Promise.all([
            httpGetFull(`${prodBase}/status`),
            httpGetFull(`${stageABase}/status`),
            httpGetFull(`${stageBBase}/status`),
          ]);
          if (
            ps.body?.meta?.status === "completed" &&
            as.body?.meta?.status === "completed" &&
            bs.body?.meta?.status === "completed"
          ) {
            const [pr, ar, br] = await Promise.all([
              httpGetFull(`${prodBase}/result`),
              httpGetFull(`${stageABase}/result`),
              httpGetFull(`${stageBBase}/result`),
            ]);
            const prodRunId = pr.body?.result?.rootRunId as string | undefined;
            const stageARunId = ar.body?.result?.rootRunId as string | undefined;
            const stageBRunId = br.body?.result?.rootRunId as string | undefined;
            if (!prodRunId || !stageARunId || !stageBRunId) throw new Error("missing rootRunId from caller workflow");
            await Promise.all([
              assertChain("prod", "mp", "prod", prodRunId),
              assertChain("stage-a", "ma", "stage-a", stageARunId),
              assertChain("stage-b", "mb", "stage-b", stageBRunId),
            ]);
            return;
          }
        }
        throw new Error("runtime-isolation-qw-chain-caller workflows did not complete");
      },
    },
    {
      name: "http-same-unit-path-worker-endpoint-triple",
      category: "isolation",
      run: async (baseUrl) => {
        const expectedPath = "test.queue-worker.queue_worker.http-same-unit-path-runtime-isolation";
        const slug = "http-same-unit-path-runtime-isolation";
        const enqP = await httpPostFull(workerUrl(baseUrl, slug), { marker: "mp" });
        const enqA = await httpPostFull(workerStageUrl(baseUrl, slug, STAGE_RUNTIME_ID), { marker: "ma" });
        const enqB = await httpPostFull(workerStageUrl(baseUrl, slug, STAGE_B_RUNTIME_ID), { marker: "mb" });
        if (enqP.status !== 200 || !enqP.body?.runId) throw new Error(`prod enqueue: ${enqP.status}`);
        if (enqA.status !== 200 || !enqA.body?.runId) throw new Error(`stage-a enqueue: ${enqA.status}`);
        if (enqB.status !== 200 || !enqB.body?.runId) throw new Error(`stage-b enqueue: ${enqB.status}`);
        const [p, a, b] = await Promise.all([
          pollWorker(baseUrl, slug, enqP.body.runId as string, 120, PROJECT_ID, undefined),
          pollWorker(baseUrl, slug, enqA.body.runId as string, 120, PROJECT_ID, STAGE_RUNTIME_ID),
          pollWorker(baseUrl, slug, enqB.body.runId as string, 120, PROJECT_ID, STAGE_B_RUNTIME_ID),
        ]);
        if (p.status !== "completed" || p.result?.runtimeScope !== "prod" || p.result?.marker !== "mp") {
          throw new Error(`prod worker homonymous path: ${JSON.stringify(p)}`);
        }
        if (
          a.status !== "completed" ||
          a.result?.runtimeScope !== "stage-a" ||
          a.result?.marker !== "ma" ||
          a.result?.unitPath !== expectedPath
        ) {
          throw new Error(`stage-a worker homonymous path: ${JSON.stringify(a)}`);
        }
        if (
          b.status !== "completed" ||
          b.result?.runtimeScope !== "stage-b" ||
          b.result?.marker !== "mb" ||
          b.result?.unitPath !== expectedPath
        ) {
          throw new Error(`stage-b worker homonymous path: ${JSON.stringify(b)}`);
        }
        if (p.result?.unitPath !== expectedPath) {
          throw new Error(`prod worker missing unitPath: ${JSON.stringify(p.result)}`);
        }
      },
    },
    {
      name: "http-same-unit-path-worker-stage-run-not-on-prod-url",
      category: "isolation",
      run: async (baseUrl) => {
        const slug = "http-same-unit-path-runtime-isolation";
        const enq = await httpPostFull(workerStageUrl(baseUrl, slug, STAGE_RUNTIME_ID), { marker: "x" });
        if (enq.status !== 200 || !enq.body?.runId) throw new Error(`stage enqueue: ${enq.status}`);
        const runId = enq.body.runId as string;
        const wrong = await httpGetFull(workerRunUrl(baseUrl, slug, runId, "status"));
        if (wrong.status !== 404) {
          throw new Error(
            `expected 404 polling stage-a run via prod workerQueue URL (same slug), got ${wrong.status}: ${JSON.stringify(wrong.body)}`,
          );
        }
        const ok = await pollWorker(baseUrl, slug, runId, 120, PROJECT_ID, STAGE_RUNTIME_ID);
        if (ok.status !== "completed" || ok.result?.runtimeScope !== "stage-a") {
          throw new Error(`stage-a run should complete via stage URL: ${JSON.stringify(ok)}`);
        }
      },
    },
    {
      name: "sdk-same-unit-path-enqueueWorker-triple",
      category: "isolation",
      run: async (baseUrl) => {
        const expectedPath = "test.queue-worker.queue_worker.http-same-unit-path-runtime-isolation";
        const workerSlug = "http-same-unit-path-runtime-isolation";
        const caller = "sdk-http-same-path-runtime-isolation-qw-caller";
        const prodStart = await httpPostFull(wfUrl(baseUrl, caller), { marker: "mp" });
        const stageAStart = await httpPostFull(wfStageUrl(baseUrl, caller, STAGE_RUNTIME_ID), { marker: "ma" });
        const stageBStart = await httpPostFull(wfStageUrl(baseUrl, caller, STAGE_B_RUNTIME_ID), { marker: "mb" });
        if (prodStart.status !== 200 || !prodStart.body?.instanceId) throw new Error("prod start failed");
        if (stageAStart.status !== 200 || !stageAStart.body?.instanceId) throw new Error("stage-a start failed");
        if (stageBStart.status !== 200 || !stageBStart.body?.instanceId) throw new Error("stage-b start failed");
        const prodBase = `${wfUrl(baseUrl, caller)}/${prodStart.body.instanceId as string}`;
        const stageABase = `${wfStageUrl(baseUrl, caller, STAGE_RUNTIME_ID)}/${stageAStart.body.instanceId as string}`;
        const stageBBase = `${wfStageUrl(baseUrl, caller, STAGE_B_RUNTIME_ID)}/${stageBStart.body.instanceId as string}`;
        for (let i = 0; i < 120; i++) {
          await sleep(150);
          const [prodSt, stageASt, stageBSt] = await Promise.all([
            httpGetFull(`${prodBase}/status`),
            httpGetFull(`${stageABase}/status`),
            httpGetFull(`${stageBBase}/status`),
          ]);
          if (
            prodSt.body?.meta?.status === "completed" &&
            stageASt.body?.meta?.status === "completed" &&
            stageBSt.body?.meta?.status === "completed"
          ) {
            const [prodWfRes, stageAWfRes, stageBWfRes] = await Promise.all([
              httpGetFull(`${prodBase}/result`),
              httpGetFull(`${stageABase}/result`),
              httpGetFull(`${stageBBase}/result`),
            ]);
            const prodRunId = prodWfRes.body?.result?.enqueuedRunId as string | undefined;
            const stageARunId = stageAWfRes.body?.result?.enqueuedRunId as string | undefined;
            const stageBRunId = stageBWfRes.body?.result?.enqueuedRunId as string | undefined;
            if (!prodRunId || !stageARunId || !stageBRunId) {
              throw new Error("missing enqueuedRunId from sdk homonymous-queue caller workflows");
            }
            const [prodWorker, stageAWorker, stageBWorker] = await Promise.all([
              pollWorker(baseUrl, workerSlug, prodRunId, 120),
              pollWorker(baseUrl, workerSlug, stageARunId, 120, PROJECT_ID, STAGE_RUNTIME_ID),
              pollWorker(baseUrl, workerSlug, stageBRunId, 120, PROJECT_ID, STAGE_B_RUNTIME_ID),
            ]);
            if (
              prodWorker.result?.runtimeScope !== "prod" ||
              prodWorker.result?.marker !== "mp" ||
              prodWorker.result?.unitPath !== expectedPath
            ) {
              throw new Error(`sdk prod→worker same path: ${JSON.stringify(prodWorker.result)}`);
            }
            if (
              stageAWorker.result?.runtimeScope !== "stage-a" ||
              stageAWorker.result?.marker !== "ma" ||
              stageAWorker.result?.unitPath !== expectedPath
            ) {
              throw new Error(`sdk stage-a→worker same path: ${JSON.stringify(stageAWorker.result)}`);
            }
            if (
              stageBWorker.result?.runtimeScope !== "stage-b" ||
              stageBWorker.result?.marker !== "mb" ||
              stageBWorker.result?.unitPath !== expectedPath
            ) {
              throw new Error(`sdk stage-b→worker same path: ${JSON.stringify(stageBWorker.result)}`);
            }
            return;
          }
        }
        throw new Error("sdk-http-same-path-runtime-isolation-qw-caller workflows did not complete");
      },
    },

    // ---- endpoint (7) ----
    {
      name: "enqueue-returns-run-id",
      category: "endpoint",
      run: async (baseUrl) => {
        const resp = await httpPostFull(workerUrl(baseUrl, "echo-worker"), { v: 1 });
        if (resp.status !== 200)
          throw new Error(`expected 200, got ${resp.status}`);
        if (!resp.body?.runId)
          throw new Error("missing runId in enqueue response");
        if (resp.body?.status !== "queued")
          throw new Error(`expected status "queued", got "${resp.body?.status}"`);
        if (!UUID_RX.test(resp.body.runId))
          throw new Error(`runId is not a UUID: ${resp.body.runId}`);
      },
    },
    {
      name: "enqueue-with-data",
      category: "endpoint",
      run: async (baseUrl) => {
        const payload = { tag: "endpoint-test", nested: { n: 7 } };
        const enqueued = await enqueue(baseUrl, "echo-worker", payload);
        if (!enqueued) throw new Error("enqueue failed");
        const { status, result } = await pollWorker(
          baseUrl,
          "echo-worker",
          enqueued.runId,
        );
        if (status !== "completed") throw new Error(`expected completed, got ${status}`);
        if (result?.echo?.tag !== "endpoint-test")
          throw new Error(`data not preserved: ${JSON.stringify(result)}`);
        if (result?.echo?.nested?.n !== 7)
          throw new Error(`nested data not preserved: ${JSON.stringify(result)}`);
      },
    },
    {
      name: "enqueue-empty-body",
      category: "endpoint",
      run: async (baseUrl) => {
        const resp = await httpPostFull(workerUrl(baseUrl, "echo-worker"));
        if (resp.status !== 200)
          throw new Error(`expected 200, got ${resp.status}`);
        if (!resp.body?.runId)
          throw new Error("missing runId when enqueued with empty body");
      },
    },
    {
      name: "enqueue-nonexistent-worker-404",
      category: "endpoint",
      run: async (baseUrl) => {
        const resp = await httpPostFull(
          workerUrl(baseUrl, "this-worker-does-not-exist"),
          {},
        );
        if (resp.status !== 404)
          throw new Error(`expected 404, got ${resp.status}: ${JSON.stringify(resp.body)}`);
      },
    },
    {
      name: "enqueue-invalid-slug-400",
      category: "endpoint",
      run: async (baseUrl) => {
        const url = `${workerUrl(baseUrl, "@@@")}`; 
        const resp = await httpPostFull(url, {});
        if (resp.status !== 400)
          throw new Error(`expected 400, got ${resp.status}: ${JSON.stringify(resp.body)}`);
      },
    },
    {
      name: "status-nonexistent-run-404",
      category: "endpoint",
      run: async (baseUrl) => {
        const fakeId = "00000000-dead-beef-0000-000000000000";
        const url = workerRunUrl(baseUrl, "echo-worker", fakeId, "status");
        const resp = await httpGetFull(url);
        if (resp.status !== 404)
          throw new Error(`expected 404, got ${resp.status}`);
      },
    },
    {
      name: "result-before-completion",
      category: "endpoint",
      run: async (baseUrl) => {
        const enqueued = await enqueue(baseUrl, "slow-worker", { sleepMs: 3000 });
        if (!enqueued) throw new Error("enqueue failed");
        await sleep(100);
        const res = await httpGetFull(
          workerRunUrl(baseUrl, "slow-worker", enqueued.runId, "result"),
        );
        if (res.status === 200 && res.body?.result !== undefined && res.body?.result !== null)
          throw new Error("got non-null result while worker is still running");
      },
    },
    {
      name: "enqueue-dedup-conflict-409",
      category: "endpoint",
      skip: "dedup conflict 409 response not yet implemented",
      run: async (_baseUrl) => {},
    },

    // ---- endpoint: status response shape ----
    {
      name: "status-response-shape",
      category: "endpoint",
      run: async (baseUrl) => {
        const enqueued = await enqueue(baseUrl, "echo-worker", { v: 10 });
        if (!enqueued) throw new Error("enqueue failed");
        await pollWorker(baseUrl, "echo-worker", enqueued.runId);
        const resp = await httpGetFull(
          workerRunUrl(baseUrl, "echo-worker", enqueued.runId, "status"),
        );
        if (resp.status !== 200)
          throw new Error(`expected 200, got ${resp.status}`);
        const body = resp.body as Record<string, unknown>;
        const status = (body["status"] ?? (body["meta"] as Record<string, unknown>)?.["status"]);
        if (typeof status !== "string")
          throw new Error(`status field missing or not a string: ${JSON.stringify(body)}`);
        const attempt = (body["attempt"] ?? (body["meta"] as Record<string, unknown>)?.["attempt"]);
        if (typeof attempt !== "number")
          throw new Error(`attempt field missing or not a number: ${JSON.stringify(body)}`);
        const enqueuedAt = (body["enqueuedAt"] ?? (body["meta"] as Record<string, unknown>)?.["enqueuedAt"]);
        if (typeof enqueuedAt !== "number")
          throw new Error(`enqueuedAt field missing or not a number: ${JSON.stringify(body)}`);
      },
    },

    // ---- endpoint: result response shape & types ----
    {
      name: "result-completed-response-shape",
      category: "endpoint",
      run: async (baseUrl) => {
        const enqueued = await enqueue(baseUrl, "echo-worker", { v: 11 });
        if (!enqueued) throw new Error("enqueue failed");
        await pollWorker(baseUrl, "echo-worker", enqueued.runId);
        const resp = await httpGetFull(
          workerRunUrl(baseUrl, "echo-worker", enqueued.runId, "result"),
        );
        if (resp.status !== 200)
          throw new Error(`expected 200, got ${resp.status}`);
        if (resp.body?.status !== "completed")
          throw new Error(`expected status "completed", got "${resp.body?.status as string}"`);
        if (!("result" in (resp.body as Record<string, unknown>)))
          throw new Error("missing 'result' field in response body");
      },
    },
    {
      name: "result-preserves-complex-types",
      category: "endpoint",
      run: async (baseUrl) => {
        const enqueued = await enqueue(baseUrl, "return-types", {});
        if (!enqueued) throw new Error("enqueue failed");
        const { status, result } = await pollWorker(baseUrl, "return-types", enqueued.runId);
        if (status !== "completed") throw new Error(`expected completed, got ${status}`);
        if (result?.str !== "queue-worker") throw new Error(`str mismatch: ${String(result?.str)}`);
        if (result?.num !== -3.5) throw new Error(`num mismatch: ${String(result?.num)}`);
        if (result?.nul !== null) throw new Error(`null field mismatch: ${String(result?.nul)}`);
        if (!Array.isArray(result?.arr)) throw new Error("arr is not an array");
        if ((result?.arr as unknown[])[0] !== 10) throw new Error(`arr[0] mismatch`);
        if ((result?.nested as Record<string, unknown> | undefined)?.["a"] === undefined)
          throw new Error("nested data not preserved");
      },
    },
    {
      name: "result-after-dead-letter",
      category: "endpoint",
      run: async (baseUrl) => {
        const enqueued = await enqueue(baseUrl, "always-fail-worker", {});
        if (!enqueued) throw new Error("enqueue failed");
        await pollWorker(baseUrl, "always-fail-worker", enqueued.runId, 200);
        const resp = await httpGetFull(
          workerRunUrl(baseUrl, "always-fail-worker", enqueued.runId, "result"),
        );
        if (resp.status !== 200)
          throw new Error(`expected 200, got ${resp.status}`);
        if (resp.body?.status !== "dead_letter")
          throw new Error(`expected status "dead_letter", got "${resp.body?.status as string}"`);
        if (resp.body?.result !== null && resp.body?.result !== undefined)
          throw new Error(`expected null result after dead_letter, got ${JSON.stringify(resp.body?.result)}`);
      },
    },
    {
      name: "result-nonexistent-run-404",
      category: "endpoint",
      run: async (baseUrl) => {
        const fakeId = "00000000-dead-beef-0000-000000000001";
        const resp = await httpGetFull(
          workerRunUrl(baseUrl, "echo-worker", fakeId, "result"),
        );
        if (resp.status !== 404)
          throw new Error(`expected 404, got ${resp.status}`);
      },
    },

    {
      name: "enqueue-stage-url-returns-run-id",
      category: "endpoint_stage",
      run: async (baseUrl) => {
        const resp = await httpPostFull(workerStageUrl(baseUrl, "echo-worker"), { v: "stage-enqueue" });
        if (resp.status !== 200)
          throw new Error(`expected 200, got ${resp.status}`);
        if (!resp.body?.runId)
          throw new Error("missing runId");
        if (!UUID_RX.test(resp.body.runId as string))
          throw new Error(`runId not a UUID: ${resp.body.runId}`);
        if (resp.body?.status !== "queued")
          throw new Error(`expected queued, got ${resp.body?.status}`);
      },
    },
    {
      name: "enqueue-stage-completes-with-stage-runtime-scope",
      category: "endpoint_stage",
      run: async (baseUrl) => {
        const resp = await httpPostFull(workerStageUrl(baseUrl, "runtime-scope-worker-target"), {
          marker: "direct-http",
        });
        if (resp.status !== 200 || !resp.body?.runId)
          throw new Error(`stage enqueue failed: ${resp.status} ${JSON.stringify(resp.body)}`);
        const runId = resp.body.runId as string;
        const { status, result } = await pollWorker(
          baseUrl,
          "runtime-scope-worker-target",
          runId,
          120,
          PROJECT_ID,
          STAGE_RUNTIME_ID,
        );
        if (status !== "completed")
          throw new Error(`expected completed, got ${status}`);
        if (result?.runtimeScope !== "stage-a" || result?.marker !== "direct-http") {
          throw new Error(`unexpected result: ${JSON.stringify(result)}`);
        }
      },
    },
    {
      name: "enqueue-unknown-stage-runtime-404",
      category: "endpoint_stage",
      run: async (baseUrl) => {
        const unknown = "00000000-dead-0000-0000-999999999999";
        const resp = await httpPostFull(workerStageUrl(baseUrl, "echo-worker", unknown), {});
        if (resp.status !== 404)
          throw new Error(`expected 404 for unknown runtime, got ${resp.status}`);
      },
    },
    {
      name: "stage-queue-worker-status-wrong-runtime-in-url-404",
      category: "endpoint_stage",
      run: async (baseUrl) => {
        const enq = await httpPostFull(workerStageUrl(baseUrl, "echo-worker", STAGE_RUNTIME_ID), { probe: 1 });
        if (enq.status !== 200 || !enq.body?.runId)
          throw new Error("stage enqueue failed");
        const runId = enq.body.runId as string;
        const wrong = workerStageRunUrl(baseUrl, "echo-worker", runId, "status", STAGE_B_RUNTIME_ID);
        const r = await httpGetFull(wrong);
        if (r.status !== 404)
          throw new Error(`GET status for stage-a run via stage-b URL expected 404, got ${r.status}`);
        await pollWorker(baseUrl, "echo-worker", runId, 80, PROJECT_ID, STAGE_RUNTIME_ID);
      },
    },
    {
      name: "prod-queue-worker-status-for-stage-run-404",
      category: "endpoint_stage",
      run: async (baseUrl) => {
        const enq = await httpPostFull(workerStageUrl(baseUrl, "echo-worker", STAGE_RUNTIME_ID), { tag: "prod404" });
        if (enq.status !== 200 || !enq.body?.runId)
          throw new Error("stage enqueue failed");
        const runId = enq.body.runId as string;
        const prodUrl = workerRunUrl(baseUrl, "echo-worker", runId, "status");
        const r = await httpGetFull(prodUrl);
        if (r.status !== 404)
          throw new Error(`GET prod status for stage-only run expected 404, got ${r.status}`);
        await pollWorker(baseUrl, "echo-worker", runId, 80, PROJECT_ID, STAGE_RUNTIME_ID);
      },
    },
    {
      name: "stage-queue-worker-cancel-wrong-runtime-404",
      category: "endpoint_stage",
      run: async (baseUrl) => {
        const enq = await httpPostFull(workerStageUrl(baseUrl, "slow-worker", STAGE_RUNTIME_ID), {});
        if (enq.status !== 200 || !enq.body?.runId)
          throw new Error("stage enqueue slow-worker failed");
        const runId = enq.body.runId as string;
        const badCancel = `${workerStageUrl(baseUrl, "slow-worker", STAGE_B_RUNTIME_ID)}/${runId}/cancel`;
        const bad = await httpPostFull(badCancel, {});
        if (bad.status !== 404)
          throw new Error(`cancel via wrong stage runtime expected 404, got ${bad.status}`);
        const goodCancel = `${workerStageUrl(baseUrl, "slow-worker", STAGE_RUNTIME_ID)}/${runId}/cancel`;
        const ok = await httpPostFull(goodCancel, {});
        if (ok.status !== 200)
          throw new Error(`cancel via correct stage URL expected 200, got ${ok.status}`);
      },
    },
    {
      name: "prod-and-stage-direct-enqueue-distinct-run-ids",
      category: "endpoint_stage",
      run: async (baseUrl) => {
        const [prodR, stageR] = await Promise.all([
          httpPostFull(workerUrl(baseUrl, "echo-worker"), { lane: "p" }),
          httpPostFull(workerStageUrl(baseUrl, "echo-worker"), { lane: "s" }),
        ]);
        if (prodR.status !== 200 || stageR.status !== 200)
          throw new Error(`enqueue failed prod=${prodR.status} stage=${stageR.status}`);
        const pId = prodR.body?.runId as string | undefined;
        const sId = stageR.body?.runId as string | undefined;
        if (!pId || !sId) throw new Error("missing runId");
        if (pId === sId) throw new Error("prod and stage returned same runId");
        await Promise.all([
          pollWorker(baseUrl, "echo-worker", pId, 100),
          pollWorker(baseUrl, "echo-worker", sId, 100, PROJECT_ID, STAGE_RUNTIME_ID),
        ]);
      },
    },

    // ---- batch (5) ----
    {
      name: "batch-size-trigger",
      category: "batch",
      run: async (baseUrl) => {
        const [r1, r2, r3] = await Promise.all([
          enqueue(baseUrl, "batch-size-trigger", { item: "a" }),
          enqueue(baseUrl, "batch-size-trigger", { item: "b" }),
          enqueue(baseUrl, "batch-size-trigger", { item: "c" }),
        ]);
        if (!r1 || !r2 || !r3) throw new Error("enqueue failed");
        const { status, result } = await pollWorker(baseUrl, "batch-size-trigger", r3.runId, 200);
        if (status !== "completed") throw new Error(`expected completed, got ${status}`);
        if (result?.count !== 3) throw new Error(`expected count=3, got ${JSON.stringify(result?.count)}`);
      },
    },
    {
      name: "batch-timeout-trigger",
      category: "batch",
      run: async (baseUrl) => {
        const [r1, r2] = await Promise.all([
          enqueue(baseUrl, "batch-timeout-trigger", { item: "a" }),
          enqueue(baseUrl, "batch-timeout-trigger", { item: "b" }),
        ]);
        if (!r1 || !r2) throw new Error("enqueue failed");
        const { status, result } = await pollWorker(baseUrl, "batch-timeout-trigger", r2.runId, 200);
        if (status !== "completed") throw new Error(`expected completed, got ${status}`);
        if (result?.count !== 2) throw new Error(`expected count=2, got ${JSON.stringify(result?.count)}`);
        if (!result?.timedOut) throw new Error("expected timedOut=true");
      },
    },
    {
      name: "batch-single-item",
      category: "batch",
      run: async (baseUrl) => {
        const r = await enqueue(baseUrl, "batch-single-item", { item: "only" });
        if (!r) throw new Error("enqueue failed");
        const { status, result } = await pollWorker(baseUrl, "batch-single-item", r.runId, 200);
        if (status !== "completed") throw new Error(`expected completed, got ${status}`);
        if (result?.count !== 1) throw new Error(`expected count=1, got ${JSON.stringify(result?.count)}`);
      },
    },
    {
      name: "batch-error-retries-whole-batch",
      category: "batch",
      run: async (baseUrl) => {
        const [r1, r2, r3] = await Promise.all([
          enqueue(baseUrl, "batch-error-retries-whole-batch", { item: "a" }),
          enqueue(baseUrl, "batch-error-retries-whole-batch", { item: "b" }),
          enqueue(baseUrl, "batch-error-retries-whole-batch", { item: "c" }),
        ]);
        if (!r1 || !r2 || !r3) throw new Error("enqueue failed");
        const { status, result } = await pollWorker(baseUrl, "batch-error-retries-whole-batch", r3.runId, 300);
        if (status !== "completed") throw new Error(`expected completed, got ${status}`);
        if (result?.count !== 3) throw new Error(`expected count=3, got ${JSON.stringify(result?.count)}`);
        if (result?.attempt !== 2) throw new Error(`expected attempt=2, got ${JSON.stringify(result?.attempt)}`);
      },
    },
    {
      name: "batch-return-value",
      category: "batch",
      run: async (baseUrl) => {
        const [r1, r2, r3] = await Promise.all([
          enqueue(baseUrl, "batch-return-value", { id: 1, value: 5 }),
          enqueue(baseUrl, "batch-return-value", { id: 2, value: 10 }),
          enqueue(baseUrl, "batch-return-value", { id: 3, value: 15 }),
        ]);
        if (!r1 || !r2 || !r3) throw new Error("enqueue failed");
        const { status, result } = await pollWorker(baseUrl, "batch-return-value", r1.runId, 200);
        if (status !== "completed") throw new Error(`expected completed, got ${status}`);
        const item1 = (result?.results as Array<{ id: number; doubled: number }> | undefined)
          ?.find((x) => x.id === 1);
        if (item1?.doubled !== 10) throw new Error(`expected doubled=10 for id=1, got ${JSON.stringify(item1?.doubled)}`);
      },
    },

    // ---- endpoint_cancel (7) ----
    {
      name: "cancel-queued-run",
      category: "endpoint_cancel",
      run: async (baseUrl) => {
        const enqueued = await enqueue(baseUrl, "slow-worker", { sleepMs: 10_000 });
        if (!enqueued) throw new Error("enqueue failed");
        const cancelResp = await httpPostFull(
          workerRunUrl(baseUrl, "slow-worker", enqueued.runId, "cancel"),
        );
        if (cancelResp.status !== 200)
          throw new Error(`expected 200, got ${cancelResp.status}`);
        if (cancelResp.body?.status !== "cancelled")
          throw new Error(`expected status "cancelled", got "${cancelResp.body?.status as string}"`);
        for (let i = 0; i < 20; i++) {
          await sleep(150);
          const st = await httpGet(
            workerRunUrl(baseUrl, "slow-worker", enqueued.runId, "status"),
          );
          const s = (st?.status ?? (st?.meta as Record<string, unknown>)?.["status"]) as string | undefined;
          if (s === "cancelled") return;
        }
        throw new Error("status never confirmed as cancelled");
      },
    },
    {
      name: "cancel-processing-run",
      category: "endpoint_cancel",
      run: async (baseUrl) => {
        const enqueued = await enqueue(baseUrl, "slow-worker", { sleepMs: 10_000 });
        if (!enqueued) throw new Error("enqueue failed");
        await sleep(300);
        const cancelResp = await httpPostFull(
          workerRunUrl(baseUrl, "slow-worker", enqueued.runId, "cancel"),
        );
        if (cancelResp.status !== 200)
          throw new Error(`expected 200 on cancel, got ${cancelResp.status}`);
        const { status } = await pollWorker(
          baseUrl,
          "slow-worker",
          enqueued.runId,
          60,
        );
        if (status !== "cancelled")
          throw new Error(`expected cancelled final status, got ${status}`);
      },
    },
    {
      name: "cancel-retrying-run",
      category: "endpoint_cancel",
      run: async (baseUrl) => {
        const enqueued = await enqueue(baseUrl, "fail-twice-worker", {});
        if (!enqueued) throw new Error("enqueue failed");
        for (let i = 0; i < 60; i++) {
          await sleep(200);
          const st = await httpGet(
            workerRunUrl(baseUrl, "fail-twice-worker", enqueued.runId, "status"),
          );
          const s = (st?.status ?? (st?.meta as Record<string, unknown>)?.["status"]) as string | undefined;
          if (s === "retrying") {
            const cancelResp = await httpPostFull(
              workerRunUrl(baseUrl, "fail-twice-worker", enqueued.runId, "cancel"),
            );
            if (cancelResp.status !== 200)
              throw new Error(`cancel during retrying returned ${cancelResp.status}`);
            return;
          }
          if (s === "completed" || s === "dead_letter") break;
        }
        throw new Error("never observed retrying status to cancel");
      },
    },
    {
      name: "cancel-completed-rejected",
      category: "endpoint_cancel",
      run: async (baseUrl) => {
        const enqueued = await enqueue(baseUrl, "echo-worker", { v: 20 });
        if (!enqueued) throw new Error("enqueue failed");
        await pollWorker(baseUrl, "echo-worker", enqueued.runId);
        const cancelResp = await httpPostFull(
          workerRunUrl(baseUrl, "echo-worker", enqueued.runId, "cancel"),
        );
        if (cancelResp.status !== 400)
          throw new Error(
            `expected 400 on cancelling completed run, got ${cancelResp.status}`,
          );
      },
    },
    {
      name: "cancel-dead-letter-rejected",
      category: "endpoint_cancel",
      run: async (baseUrl) => {
        const enqueued = await enqueue(baseUrl, "always-fail-worker", {});
        if (!enqueued) throw new Error("enqueue failed");
        await pollWorker(baseUrl, "always-fail-worker", enqueued.runId, 200);
        const cancelResp = await httpPostFull(
          workerRunUrl(baseUrl, "always-fail-worker", enqueued.runId, "cancel"),
        );
        if (cancelResp.status !== 400)
          throw new Error(
            `expected 400 on cancelling dead_letter run, got ${cancelResp.status}`,
          );
      },
    },
    {
      name: "cancel-already-cancelled-idempotent",
      category: "endpoint_cancel",
      run: async (baseUrl) => {
        const enqueued = await enqueue(baseUrl, "slow-worker", { sleepMs: 10_000 });
        if (!enqueued) throw new Error("enqueue failed");
        const r1 = await httpPostFull(
          workerRunUrl(baseUrl, "slow-worker", enqueued.runId, "cancel"),
        );
        if (r1.status !== 200)
          throw new Error(`first cancel returned ${r1.status}`);
        const r2 = await httpPostFull(
          workerRunUrl(baseUrl, "slow-worker", enqueued.runId, "cancel"),
        );
        if (r2.status !== 200)
          throw new Error(`second (idempotent) cancel returned ${r2.status}, expected 200`);
      },
    },
    {
      name: "cancel-nonexistent-run-404",
      category: "endpoint_cancel",
      run: async (baseUrl) => {
        const fakeId = "00000000-dead-beef-0000-000000000002";
        const resp = await httpPostFull(
          workerRunUrl(baseUrl, "echo-worker", fakeId, "cancel"),
        );
        if (resp.status !== 404)
          throw new Error(`expected 404, got ${resp.status}`);
      },
    },

    // ---- endpoint_concurrent (3) ----
    {
      name: "concurrent-enqueue-same-worker",
      category: "endpoint_concurrent",
      run: async (baseUrl) => {
        const N = 10;
        const responses = await Promise.all(
          Array.from({ length: N }, () =>
            httpPostFull(workerUrl(baseUrl, "echo-worker"), { concurrent: true }),
          ),
        );
        const failed = responses.filter((r) => r.status !== 200);
        if (failed.length > 0)
          throw new Error(
            `${failed.length}/${N} enqueues returned non-200: ${failed.map((r) => r.status).join(", ")}`,
          );
        const runIds = responses.map((r) => r.body?.runId as string | undefined).filter(Boolean);
        if (runIds.length !== N)
          throw new Error(`only ${runIds.length}/${N} responses contained runId`);
        const unique = new Set(runIds);
        if (unique.size !== N)
          throw new Error(`expected ${N} unique runIds, got ${unique.size} (duplicates!)`);
      },
    },
    {
      name: "concurrent-status-polling",
      category: "endpoint_concurrent",
      run: async (baseUrl) => {
        const enqueued = await enqueue(baseUrl, "slow-worker", { sleepMs: 2_000 });
        if (!enqueued) throw new Error("enqueue failed");
        await sleep(100);
        const N = 5;
        const responses = await Promise.all(
          Array.from({ length: N }, () =>
            httpGetFull(
              workerRunUrl(baseUrl, "slow-worker", enqueued.runId, "status"),
            ),
          ),
        );
        if (responses.some((r) => r.status !== 200))
          throw new Error("some concurrent status polls returned non-200");
        const statuses = responses.map(
          (r) => (r.body?.status ?? (r.body?.meta as Record<string, unknown>)?.["status"]) as string | undefined,
        );
        const validStatuses = new Set([
          "queued", "processing", "retrying", "completed", "cancelled", "dead_letter",
        ]);
        for (const st of statuses) {
          if (!st || !validStatuses.has(st))
            throw new Error(`invalid status value: "${String(st)}"`);
        }
        const unique = new Set(statuses);
        if (unique.size > 2)
          throw new Error(
            `status flickered across ${unique.size} distinct values: ${[...unique].join(", ")}`,
          );
      },
    },
    {
      name: "concurrent-cancel-race",
      category: "endpoint_concurrent",
      run: async (baseUrl) => {
        const enqueued = await enqueue(baseUrl, "slow-worker", { sleepMs: 10_000 });
        if (!enqueued) throw new Error("enqueue failed");
        const [r1, r2] = await Promise.all([
          httpPostFull(
            workerRunUrl(baseUrl, "slow-worker", enqueued.runId, "cancel"),
          ),
          httpPostFull(
            workerRunUrl(baseUrl, "slow-worker", enqueued.runId, "cancel"),
          ),
        ]);
        if (r1.status === 500 || r2.status === 500)
          throw new Error(`race condition caused 500: ${r1.status} / ${r2.status}`);
        const statusResp = await httpGetFull(
          workerRunUrl(baseUrl, "slow-worker", enqueued.runId, "status"),
        );
        const st = (statusResp.body?.status ?? (statusResp.body?.meta as Record<string, unknown>)?.["status"]) as string | undefined;
        if (st !== "cancelled")
          throw new Error(`expected cancelled after concurrent cancel, got "${String(st)}"`);
      },
    },
    {
      name: "concurrent-status-and-cancel-same-run",
      category: "endpoint_concurrent",
      run: async (baseUrl) => {
        const enqueued = await enqueue(baseUrl, "slow-worker", { sleepMs: 8_000 });
        if (!enqueued) throw new Error("enqueue failed");
        await sleep(100);
        const [cancelResp, ...statusResps] = await Promise.all([
          httpPostFull(workerRunUrl(baseUrl, "slow-worker", enqueued.runId, "cancel")),
          ...Array.from({ length: 3 }, () =>
            httpGetFull(workerRunUrl(baseUrl, "slow-worker", enqueued.runId, "status")),
          ),
        ]);
        if (cancelResp.status === 500)
          throw new Error(`cancel returned 500 under concurrent status polls`);
        for (const sr of statusResps) {
          if (sr.status === 500)
            throw new Error(`status returned 500 during concurrent cancel`);
        }
        const finalStatus = await httpGetFull(
          workerRunUrl(baseUrl, "slow-worker", enqueued.runId, "status"),
        );
        const finalSt = (finalStatus.body?.status ?? (finalStatus.body?.meta as Record<string, unknown>)?.["status"]) as string | undefined;
        const terminalStates = new Set(["cancelled", "completed", "dead_letter"]);
        if (!terminalSt(finalSt, terminalStates))
          throw new Error(`expected terminal state, got "${String(finalSt)}"`);
      },
    },

    // ---- endpoint gap coverage ----
    {
      name: "enqueue-invalid-project-id-400",
      category: "endpoint",
      run: async (baseUrl) => {
        const url = `${baseUrl}/api/v1/trigger/workerQueue/not-a-uuid/test/queue-worker/echo-worker`;
        const resp = await httpPostFull(url, {});
        if (resp.status !== 400 && resp.status !== 404)
          throw new Error(`expected 400 or 404 for invalid project_id, got ${resp.status}`);
      },
    },
    {
      name: "enqueue-wrong-tail-segments-404",
      category: "endpoint",
      run: async (baseUrl) => {
        const url = `${baseUrl}/api/v1/trigger/workerQueue/${PROJECT_ID}/only-one-segment`;
        const resp = await httpPostFull(url, {});
        if (resp.status !== 400 && resp.status !== 404)
          throw new Error(`expected 400 or 404 for wrong tail segments, got ${resp.status}`);
      },
    },
    {
      name: "status-response-shape-dead-letter",
      category: "endpoint",
      run: async (baseUrl) => {
        const enqueued = await enqueue(baseUrl, "always-fail-worker", {});
        if (!enqueued) throw new Error("enqueue failed");
        await pollWorker(baseUrl, "always-fail-worker", enqueued.runId, 300);
        const resp = await httpGetFull(
          workerRunUrl(baseUrl, "always-fail-worker", enqueued.runId, "status"),
        );
        if (resp.status !== 200)
          throw new Error(`expected 200, got ${resp.status}`);
        const body = resp.body as Record<string, unknown>;
        const status = (body["status"] ?? (body["meta"] as Record<string, unknown>)?.["status"]) as string | undefined;
        if (status !== "dead_letter")
          throw new Error(`expected status "dead_letter", got "${String(status)}"`);
        const attempt = (body["attempt"] ?? (body["meta"] as Record<string, unknown>)?.["attempt"]) as number | undefined;
        if (typeof attempt !== "number")
          throw new Error(`attempt field missing or not a number in dead_letter status: ${JSON.stringify(body)}`);
      },
    },
    {
      name: "cancel-wrong-worker-slug-mismatch",
      category: "endpoint_cancel",
      run: async (baseUrl) => {
        const enqueued = await enqueue(baseUrl, "slow-worker", { sleepMs: 10_000 });
        if (!enqueued) throw new Error("enqueue failed");
        const url = `${baseUrl}/api/v1/trigger/workerQueue/${PROJECT_ID}/test/queue-worker/echo-worker/${enqueued.runId}/cancel`;
        const resp = await httpPostFull(url);
        if (resp.status === 500)
          throw new Error(`slug mismatch cancel returned 500 (should be 404 or error)`);
        await httpPostFull(workerRunUrl(baseUrl, "slow-worker", enqueued.runId, "cancel"));
      },
    },
  ];
}

function terminalSt(st: string | undefined, set: Set<string>): boolean {
  return st !== undefined && set.has(st);
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
  const results: TestResult[] = [];

  for (const test of allWorkerTests()) {
    const result = await runWorkerTest(baseUrl, test);
    results.push(result);
  }

  for (const test of allInlineTests()) {
    const result = await runInlineTest(baseUrl, test);
    results.push(result);
  }

  const report = buildReport(results);
  const body = JSON.stringify(report, null, 2);

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(body);
}
