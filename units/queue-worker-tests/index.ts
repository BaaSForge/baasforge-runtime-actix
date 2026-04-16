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

const PROJECT_ID = "00000000-aaaa-bbbb-cccc-000000000011";
const ALT_PROJECT_ID = "00000000-aaaa-bbbb-cccc-000000000012";

function getBaseUrl(req: IncomingMessage): string {
  const host = req.headers.host ?? "127.0.0.1:3333";
  return `http://${host}`;
}

function workerUrl(baseUrl: string, slug: string, projectId = PROJECT_ID): string {
  return `${baseUrl}/api/v1/trigger/workerQueue/${projectId}/test/queue-worker/${slug}`;
}

function workerRunUrl(baseUrl: string, slug: string, runId: string, suffix: string): string {
  return `${workerUrl(baseUrl, slug)}/${runId}/${suffix}`;
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
): Promise<{ status: string; result?: any }> {
  for (let i = 0; i < maxIter; i++) {
    await sleep(150);
    const statusResp = await httpGet(workerRunUrl(baseUrl, slug, runId, "status"));
    const status: string = statusResp?.status ?? "unknown";
    if (status === "completed") {
      const resultResp = await httpGet(workerRunUrl(baseUrl, slug, runId, "result"));
      return { status, result: resultResp?.result };
    }
    if (status === "dead_letter" || status === "failed") {
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
      workerSlug: "basic/process-and-return",
      data: { value: 42, label: "hello" },
      checks: [
        { type: "eq", path: "received.value", expected: 42 },
        { type: "eq", path: "received.label", expected: "hello" },
        { type: "true", path: "processed" },
      ],
    },
    {
      name: "empty-data", category: "basic",
      workerSlug: "basic/empty-data",
      data: {},
      checks: [
        { type: "true", path: "receivedEmpty" },
        { type: "eq", path: "keys", expected: 0 },
      ],
    },
    {
      name: "return-types", category: "basic",
      workerSlug: "basic/return-types",
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
      workerSlug: "basic/async-processing",
      data: { n: 7 },
      checks: [
        { type: "eq", path: "doubled", expected: 14 },
        { type: "true", path: "asyncDone" },
      ],
    },

    // ---- retry (8) ----
    {
      name: "default-retry", category: "retry",
      workerSlug: "retry/default-retry",
      data: {},
      checks: [
        { type: "eq", path: "finalAttempt", expected: 3 },
        { type: "true", path: "ok" },
      ],
    },
    {
      name: "custom-retry-policy", category: "retry",
      workerSlug: "retry/custom-retry-policy",
      data: {},
      maxIterations: 300,
      checks: [
        { type: "eq", path: "finalAttempt", expected: 5 },
        { type: "true", path: "ok" },
      ],
    },
    {
      name: "retry-attempt-counter", category: "retry",
      workerSlug: "retry/retry-attempt-counter",
      data: { targetAttempt: 4 },
      checks: [
        { type: "eq", path: "attempt", expected: 4 },
      ],
    },
    {
      name: "retry-exponential-backoff", category: "retry",
      workerSlug: "retry/retry-exponential-backoff",
      data: {},
      maxIterations: 500,
      skip: "requires timing verification infrastructure to assert interval doubling",
      checks: [
        { type: "eq", path: "attempt", expected: 4 },
        { type: "notNull", path: "completedAt" },
      ],
    },
    {
      name: "terminal-error-no-retry", category: "retry",
      workerSlug: "retry/terminal-error-no-retry",
      data: {},
      expectDeadLetter: true,
      checks: [],
    },
    {
      name: "retry-succeeds-on-last-attempt", category: "retry",
      workerSlug: "retry/retry-succeeds-on-last-attempt",
      data: {},
      maxIterations: 300,
      checks: [
        { type: "eq", path: "finalAttempt", expected: 5 },
        { type: "true", path: "ok" },
      ],
    },
    {
      name: "retry-preserves-data", category: "retry",
      workerSlug: "retry/retry-preserves-data",
      data: { secret: "unchanged", value: 99 },
      checks: [
        { type: "eq", path: "dataOnFinalAttempt.secret", expected: "unchanged" },
        { type: "eq", path: "dataOnFinalAttempt.value", expected: 99 },
        { type: "eq", path: "attempt", expected: 3 },
      ],
    },
    {
      name: "retry-then-success-return-value", category: "retry",
      workerSlug: "retry/retry-then-success-return-value",
      data: {},
      checks: [
        { type: "eq", path: "successValue", expected: "from-successful-attempt" },
      ],
    },

    // ---- dead-letter (6) ----
    {
      name: "dead-letter-handler-called", category: "dead-letter",
      workerSlug: "dead-letter/dead-letter-handler-called",
      data: {},
      expectDeadLetter: true,
      checks: [],
    },
    {
      name: "dead-letter-receives-error", category: "dead-letter",
      workerSlug: "dead-letter/dead-letter-receives-error",
      data: {},
      expectDeadLetter: true,
      skip: "requires dead-letter handler output introspection endpoint",
      checks: [],
    },
    {
      name: "dead-letter-receives-data", category: "dead-letter",
      workerSlug: "dead-letter/dead-letter-receives-data",
      data: { originalValue: "test-payload" },
      expectDeadLetter: true,
      skip: "requires dead-letter handler output introspection endpoint",
      checks: [],
    },
    {
      name: "dead-letter-no-handler", category: "dead-letter",
      workerSlug: "dead-letter/dead-letter-no-handler",
      data: {},
      expectDeadLetter: true,
      checks: [],
    },
    {
      name: "dead-letter-handler-throws", category: "dead-letter",
      workerSlug: "dead-letter/dead-letter-handler-throws",
      data: {},
      expectDeadLetter: true,
      checks: [],
    },
    {
      name: "dead-letter-after-terminal-error", category: "dead-letter",
      workerSlug: "dead-letter/dead-letter-after-terminal-error",
      data: {},
      expectDeadLetter: true,
      checks: [],
    },

    // ---- concurrency (4) — all skip until concurrency control is implemented ----
    {
      name: "concurrency-limit", category: "concurrency",
      workerSlug: "concurrency/concurrency-limit",
      data: { id: 1 },
      skip: "requires concurrency enforcement; verify max simultaneous runs via timing",
      checks: [{ type: "notNull", path: "completedAt" }],
    },
    {
      name: "concurrency-default", category: "concurrency",
      workerSlug: "concurrency/concurrency-default",
      data: { id: 1 },
      skip: "requires multi-enqueue concurrency assertion infrastructure",
      checks: [{ type: "notNull", path: "startedAt" }],
    },
    {
      name: "concurrency-slot-release", category: "concurrency",
      workerSlug: "concurrency/concurrency-slot-release",
      data: { id: 1 },
      skip: "requires sequential timing verification across multiple enqueued items",
      checks: [{ type: "notNull", path: "completedAt" }],
    },
    {
      name: "concurrency-with-failure", category: "concurrency",
      workerSlug: "concurrency/concurrency-with-failure",
      data: { id: 1 },
      skip: "requires concurrency + retry interaction verification",
      checks: [{ type: "notNull", path: "completedAt" }],
    },

    // ---- rate-limit (4) — all skip until rate limiting is implemented ----
    {
      name: "rate-limit-basic", category: "rate-limit",
      workerSlug: "rate-limit/rate-limit-basic",
      data: { id: 1 },
      skip: "rate limiting not yet implemented",
      checks: [{ type: "notNull", path: "startedAt" }],
    },
    {
      name: "rate-limit-window-reset", category: "rate-limit",
      workerSlug: "rate-limit/rate-limit-window-reset",
      data: { id: 1 },
      skip: "rate limiting not yet implemented",
      checks: [{ type: "notNull", path: "startedAt" }],
    },
    {
      name: "rate-limit-burst-not-dropped", category: "rate-limit",
      workerSlug: "rate-limit/rate-limit-burst-not-dropped",
      data: { id: 1 },
      skip: "rate limiting not yet implemented",
      checks: [{ type: "true", path: "processed" }],
    },
    {
      name: "rate-limit-with-concurrency", category: "rate-limit",
      workerSlug: "rate-limit/rate-limit-with-concurrency",
      data: { id: 1 },
      skip: "rate limiting not yet implemented",
      checks: [{ type: "notNull", path: "startedAt" }],
    },

    // ---- batch (5) — all skip until batch mode is implemented ----
    {
      name: "batch-size-trigger", category: "batch",
      workerSlug: "batch/batch-size-trigger",
      data: { item: "a" },
      skip: "batch mode not yet implemented",
      checks: [{ type: "eq", path: "count", expected: 3 }],
    },
    {
      name: "batch-timeout-trigger", category: "batch",
      workerSlug: "batch/batch-timeout-trigger",
      data: { item: "a" },
      skip: "batch mode not yet implemented",
      checks: [
        { type: "eq", path: "count", expected: 2 },
        { type: "true", path: "timedOut" },
      ],
    },
    {
      name: "batch-single-item", category: "batch",
      workerSlug: "batch/batch-single-item",
      data: { item: "only" },
      skip: "batch mode not yet implemented",
      checks: [{ type: "eq", path: "count", expected: 1 }],
    },
    {
      name: "batch-error-retries-whole-batch", category: "batch",
      workerSlug: "batch/batch-error-retries-whole-batch",
      data: { item: "a" },
      skip: "batch mode not yet implemented",
      checks: [
        { type: "eq", path: "count", expected: 3 },
        { type: "eq", path: "attempt", expected: 2 },
      ],
    },
    {
      name: "batch-return-value", category: "batch",
      workerSlug: "batch/batch-return-value",
      data: { id: 1, value: 5 },
      skip: "batch mode not yet implemented",
      checks: [{ type: "eq", path: "results.0.doubled", expected: 10 }],
    },

    // ---- delay (3) — all skip until delay feature is implemented ----
    {
      name: "delay-basic", category: "delay",
      workerSlug: "delay/delay-basic",
      data: { enqueuedAt: Date.now() },
      skip: "delay enqueue option not yet implemented",
      checks: [{ type: "notNull", path: "processedAt" }],
    },
    {
      name: "delay-ordering", category: "delay",
      workerSlug: "delay/delay-ordering",
      data: { id: "delayed" },
      skip: "delay enqueue option not yet implemented",
      checks: [{ type: "notNull", path: "processedAt" }],
    },
    {
      name: "delay-with-retry", category: "delay",
      workerSlug: "delay/delay-with-retry",
      data: { enqueuedAt: Date.now() },
      skip: "delay enqueue option not yet implemented",
      checks: [{ type: "notNull", path: "processedAt" }],
    },

    // ---- deduplication (4) ----
    {
      name: "dedup-key-prevents-duplicate", category: "deduplication",
      workerSlug: "dedup/dedup-target",
      data: { value: "dedup-test" },
      skip: "deduplicationKey enqueue option not yet implemented",
      checks: [{ type: "eq", path: "value", expected: "dedup-test" }],
    },
    {
      name: "dedup-different-keys", category: "deduplication",
      workerSlug: "dedup/dedup-target",
      data: { value: "key-abc" },
      skip: "deduplicationKey enqueue option not yet implemented",
      checks: [{ type: "eq", path: "value", expected: "key-abc" }],
    },
    {
      name: "dedup-after-completion", category: "deduplication",
      workerSlug: "dedup/dedup-target",
      data: { value: "after-complete" },
      skip: "deduplicationKey enqueue option not yet implemented",
      checks: [{ type: "eq", path: "value", expected: "after-complete" }],
    },
    {
      name: "dedup-during-retry", category: "deduplication",
      workerSlug: "dedup/dedup-retry-target",
      data: { value: "during-retry" },
      skip: "deduplicationKey enqueue option not yet implemented",
      checks: [{ type: "eq", path: "value", expected: "during-retry" }],
    },

    // ---- timeout (3) — all skip until timeout is implemented ----
    {
      name: "timeout-basic", category: "timeout",
      workerSlug: "timeout/timeout-basic",
      data: {},
      expectDeadLetter: true,
      skip: "worker timeout not yet implemented",
      checks: [],
    },
    {
      name: "timeout-triggers-retry", category: "timeout",
      workerSlug: "timeout/timeout-triggers-retry",
      data: {},
      skip: "worker timeout not yet implemented",
      checks: [
        { type: "eq", path: "attempt", expected: 2 },
        { type: "true", path: "ok" },
      ],
    },
    {
      name: "timeout-then-dead-letter", category: "timeout",
      workerSlug: "timeout/timeout-then-dead-letter",
      data: {},
      expectDeadLetter: true,
      skip: "worker timeout not yet implemented",
      checks: [],
    },

    // ---- sdk-interface (4) ----
    {
      name: "simple-handler-form", category: "sdk-interface",
      workerSlug: "sdk-interface/simple-handler-form",
      data: { x: 6 },
      checks: [
        { type: "eq", path: "doubled", expected: 12 },
        { type: "eq", path: "form", expected: "simple" },
      ],
    },
    {
      name: "full-handler-form", category: "sdk-interface",
      workerSlug: "sdk-interface/full-handler-form",
      data: { x: 6 },
      checks: [
        { type: "eq", path: "doubled", expected: 12 },
        { type: "eq", path: "form", expected: "full" },
      ],
    },
    {
      name: "ctx-properties", category: "sdk-interface",
      workerSlug: "sdk-interface/ctx-properties",
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
      workerSlug: "cross-unit/enqueue-from-worker-a",
      data: { value: 5 },
      skip: "requires sdk.enqueueWorker implementation in queue worker context",
      checks: [{ type: "notNull", path: "enqueuedRunId" }],
    },
    {
      name: "worker-calls-workflow", category: "cross-unit",
      workerSlug: "cross-unit/worker-calls-workflow",
      data: { n: 4 },
      skip: "requires sdk.callWorkflow from queue worker context",
      checks: [
        { type: "eq", path: "n", expected: 4 },
        { type: "eq", path: "doubled", expected: 8 },
        { type: "true", path: "workerDone" },
      ],
    },
    {
      name: "worker-emits-event", category: "cross-unit",
      workerSlug: "cross-unit/worker-emits-event",
      data: { eventName: "test.worker.event", payload: { ok: true } },
      skip: "sdk.emit not yet implemented",
      checks: [
        { type: "notNull", path: "eventId" },
        { type: "true", path: "emitted" },
      ],
    },

    // ---- isolation (2) ----
    {
      name: "queue-isolation", category: "isolation",
      workerSlug: "isolation/queue-a-worker",
      data: { value: "test-a" },
      checks: [
        { type: "eq", path: "queue", expected: "a" },
        { type: "eq", path: "value", expected: "test-a" },
      ],
    },

    // ---- durability (3) ----
    {
      name: "redelivery-on-crash", category: "durability",
      workerSlug: "durability/redelivery-worker",
      data: {},
      skip: "TerminalError skips retries — redelivery simulation requires runtime-level crash injection",
      checks: [
        { type: "eq", path: "attempt", expected: 2 },
        { type: "true", path: "ok" },
      ],
    },
    {
      name: "enqueued-items-survive-restart", category: "durability",
      workerSlug: "durability/survive-restart-worker",
      data: { enqueuedBeforeRestart: true },
      skip: "requires process restart between enqueue and processing",
      checks: [
        { type: "true", path: "processed" },
        { type: "true", path: "enqueuedBeforeRestart" },
      ],
    },
    {
      name: "no-double-processing", category: "durability",
      workerSlug: "durability/no-double-processing-worker",
      data: { runId: "test-run-1" },
      skip: "requires concurrent dispatcher instances to verify exec lock",
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
          enqueue(baseUrl, "basic/multiple-workers-a", { tag: "from-a" }),
          enqueue(baseUrl, "basic/multiple-workers-b", { tag: "from-b" }),
        ]);
        if (!ra || !rb) throw new Error("enqueue failed for one or both workers");

        const [da, db] = await Promise.all([
          pollWorker(baseUrl, "basic/multiple-workers-a", ra.runId),
          pollWorker(baseUrl, "basic/multiple-workers-b", rb.runId),
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
      skip: "requires immediate status check before dispatcher picks up item; timing-sensitive",
      run: async (baseUrl) => {
        const enqueued = await enqueue(baseUrl, "lifecycle/slow-worker", { sleepMs: 3000 });
        if (!enqueued) throw new Error("enqueue failed");
        const statusResp = await httpGet(
          workerRunUrl(baseUrl, "lifecycle/slow-worker", enqueued.runId, "status"),
        );
        const status = statusResp?.status;
        if (status !== "queued" && status !== "processing")
          throw new Error(`expected 'queued' (or 'processing' if dispatched immediately), got '${status}'`);
      },
    },
    {
      name: "status-processing",
      category: "lifecycle",
      skip: "requires timing window to observe 'processing' status before completion",
      run: async (baseUrl) => {
        const enqueued = await enqueue(baseUrl, "lifecycle/slow-worker", { sleepMs: 3000 });
        if (!enqueued) throw new Error("enqueue failed");
        await sleep(200);
        const statusResp = await httpGet(
          workerRunUrl(baseUrl, "lifecycle/slow-worker", enqueued.runId, "status"),
        );
        if (statusResp?.status !== "processing")
          throw new Error(`expected 'processing', got '${statusResp?.status}'`);
      },
    },
    {
      name: "status-completed",
      category: "lifecycle",
      run: async (baseUrl) => {
        const enqueued = await enqueue(baseUrl, "basic/process-and-return", {
          value: 1,
          label: "lifecycle-test",
        });
        if (!enqueued) throw new Error("enqueue failed");
        const { status } = await pollWorker(baseUrl, "basic/process-and-return", enqueued.runId);
        if (status !== "completed") throw new Error(`expected 'completed', got '${status}'`);
      },
    },
    {
      name: "status-dead-letter",
      category: "lifecycle",
      run: async (baseUrl) => {
        const enqueued = await enqueue(baseUrl, "lifecycle/always-fail-worker", {});
        if (!enqueued) throw new Error("enqueue failed");
        const { status } = await pollWorker(
          baseUrl,
          "lifecycle/always-fail-worker",
          enqueued.runId,
          200,
        );
        if (status !== "dead_letter") throw new Error(`expected 'dead_letter', got '${status}'`);
      },
    },
    {
      name: "status-retrying",
      category: "lifecycle",
      skip: "requires timing window to observe 'retrying' status between attempts",
      run: async (baseUrl) => {
        const enqueued = await enqueue(baseUrl, "lifecycle/fail-twice-worker", {});
        if (!enqueued) throw new Error("enqueue failed");

        let sawRetrying = false;
        for (let i = 0; i < 50; i++) {
          await sleep(200);
          const statusResp = await httpGet(
            workerRunUrl(baseUrl, "lifecycle/fail-twice-worker", enqueued.runId, "status"),
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
      skip: "delay and deduplicationKey options not yet implemented",
      run: async (baseUrl) => {
        const enqueued = await enqueue(baseUrl, "sdk-interface/enqueue-options-target", {
          label: "with-options",
        });
        if (!enqueued) throw new Error("enqueue failed");
        const { status, result } = await pollWorker(
          baseUrl,
          "sdk-interface/enqueue-options-target",
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
        const enqueued = await enqueue(baseUrl, "cross-unit/target-worker", {
          payload: { source: "api-unit" },
        });
        if (!enqueued) throw new Error("enqueue failed: no runId");
        if (!UUID_RX.test(enqueued.runId))
          throw new Error(`runId is not a UUID: ${enqueued.runId}`);
        const { status, result } = await pollWorker(
          baseUrl,
          "cross-unit/target-worker",
          enqueued.runId,
        );
        if (status !== "completed") throw new Error(`expected completed, got ${status}`);
        if (!result?.ok) throw new Error("worker result.ok is not true");
      },
    },
    {
      name: "enqueue-from-workflow",
      category: "cross-unit",
      skip: "requires workflow → sdk.enqueueWorker integration",
      run: async (_baseUrl) => {
        throw new Error("not yet runnable");
      },
    },

    // ---- isolation: cross-project-isolation ----
    {
      name: "cross-project-isolation",
      category: "isolation",
      skip: "requires two project IDs routed to same runtime; verify data does not leak between projects",
      run: async (baseUrl) => {
        const [ra, rb] = await Promise.all([
          enqueue(baseUrl, "isolation/isolated-worker", { projectTag: "A" }, PROJECT_ID),
          enqueue(baseUrl, "isolation/isolated-worker", { projectTag: "B" }, ALT_PROJECT_ID),
        ]);
        if (!ra || !rb) throw new Error("enqueue failed");

        const [da, db] = await Promise.all([
          pollWorker(baseUrl, "isolation/isolated-worker", ra.runId),
          pollWorker(baseUrl, "isolation/isolated-worker", rb.runId),
        ]);

        if (da.result?.projectTag !== "A") throw new Error("project A data leaked");
        if (db.result?.projectTag !== "B") throw new Error("project B data leaked");
        if (da.result?.runId === db.result?.runId) throw new Error("run IDs collided across projects");
      },
    },

    // ---- endpoint (7) ----
    {
      name: "enqueue-returns-run-id",
      category: "endpoint",
      run: async (baseUrl) => {
        const resp = await httpPostFull(workerUrl(baseUrl, "endpoint/echo-worker"), { v: 1 });
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
        const enqueued = await enqueue(baseUrl, "endpoint/echo-worker", payload);
        if (!enqueued) throw new Error("enqueue failed");
        const { status, result } = await pollWorker(
          baseUrl,
          "endpoint/echo-worker",
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
        const resp = await httpPostFull(workerUrl(baseUrl, "endpoint/echo-worker"));
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
        const url = `${workerUrl(baseUrl, "inv@lid!!")}`; 
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
        const url = workerRunUrl(baseUrl, "endpoint/echo-worker", fakeId, "status");
        const resp = await httpGetFull(url);
        if (resp.status !== 404)
          throw new Error(`expected 404, got ${resp.status}`);
      },
    },
    {
      name: "result-before-completion",
      category: "endpoint",
      run: async (baseUrl) => {
        const enqueued = await enqueue(baseUrl, "lifecycle/slow-worker", { sleepMs: 3000 });
        if (!enqueued) throw new Error("enqueue failed");
        await sleep(100);
        const res = await httpGetFull(
          workerRunUrl(baseUrl, "lifecycle/slow-worker", enqueued.runId, "result"),
        );
        if (res.status === 200 && res.body?.result !== undefined && res.body?.result !== null)
          throw new Error("got non-null result while worker is still running");
      },
    },
    {
      name: "enqueue-dedup-conflict-409",
      category: "endpoint",
      skip: "deduplicationKey option not yet implemented",
      run: async (_baseUrl) => {
        throw new Error("not yet runnable");
      },
    },

    // ---- endpoint: status response shape ----
    {
      name: "status-response-shape",
      category: "endpoint",
      run: async (baseUrl) => {
        const enqueued = await enqueue(baseUrl, "endpoint/echo-worker", { v: 10 });
        if (!enqueued) throw new Error("enqueue failed");
        await pollWorker(baseUrl, "endpoint/echo-worker", enqueued.runId);
        const resp = await httpGetFull(
          workerRunUrl(baseUrl, "endpoint/echo-worker", enqueued.runId, "status"),
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
        const enqueued = await enqueue(baseUrl, "endpoint/echo-worker", { v: 11 });
        if (!enqueued) throw new Error("enqueue failed");
        await pollWorker(baseUrl, "endpoint/echo-worker", enqueued.runId);
        const resp = await httpGetFull(
          workerRunUrl(baseUrl, "endpoint/echo-worker", enqueued.runId, "result"),
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
        const enqueued = await enqueue(baseUrl, "basic/return-types", {});
        if (!enqueued) throw new Error("enqueue failed");
        const { status, result } = await pollWorker(baseUrl, "basic/return-types", enqueued.runId);
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
        const enqueued = await enqueue(baseUrl, "lifecycle/always-fail-worker", {});
        if (!enqueued) throw new Error("enqueue failed");
        await pollWorker(baseUrl, "lifecycle/always-fail-worker", enqueued.runId, 200);
        const resp = await httpGetFull(
          workerRunUrl(baseUrl, "lifecycle/always-fail-worker", enqueued.runId, "result"),
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
          workerRunUrl(baseUrl, "endpoint/echo-worker", fakeId, "result"),
        );
        if (resp.status !== 404)
          throw new Error(`expected 404, got ${resp.status}`);
      },
    },

    // ---- endpoint_cancel (7) ----
    {
      name: "cancel-queued-run",
      category: "endpoint_cancel",
      run: async (baseUrl) => {
        const enqueued = await enqueue(baseUrl, "lifecycle/slow-worker", { sleepMs: 10_000 });
        if (!enqueued) throw new Error("enqueue failed");
        const cancelResp = await httpPostFull(
          workerRunUrl(baseUrl, "lifecycle/slow-worker", enqueued.runId, "cancel"),
        );
        if (cancelResp.status !== 200)
          throw new Error(`expected 200, got ${cancelResp.status}`);
        if (cancelResp.body?.status !== "cancelled")
          throw new Error(`expected status "cancelled", got "${cancelResp.body?.status as string}"`);
        for (let i = 0; i < 20; i++) {
          await sleep(150);
          const st = await httpGet(
            workerRunUrl(baseUrl, "lifecycle/slow-worker", enqueued.runId, "status"),
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
        const enqueued = await enqueue(baseUrl, "lifecycle/slow-worker", { sleepMs: 10_000 });
        if (!enqueued) throw new Error("enqueue failed");
        await sleep(300);
        const cancelResp = await httpPostFull(
          workerRunUrl(baseUrl, "lifecycle/slow-worker", enqueued.runId, "cancel"),
        );
        if (cancelResp.status !== 200)
          throw new Error(`expected 200 on cancel, got ${cancelResp.status}`);
        const { status } = await pollWorker(
          baseUrl,
          "lifecycle/slow-worker",
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
      skip: "requires precise timing to cancel during retry backoff window",
      run: async (baseUrl) => {
        const enqueued = await enqueue(baseUrl, "lifecycle/fail-twice-worker", {});
        if (!enqueued) throw new Error("enqueue failed");
        for (let i = 0; i < 60; i++) {
          await sleep(200);
          const st = await httpGet(
            workerRunUrl(baseUrl, "lifecycle/fail-twice-worker", enqueued.runId, "status"),
          );
          const s = (st?.status ?? (st?.meta as Record<string, unknown>)?.["status"]) as string | undefined;
          if (s === "retrying") {
            const cancelResp = await httpPostFull(
              workerRunUrl(baseUrl, "lifecycle/fail-twice-worker", enqueued.runId, "cancel"),
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
        const enqueued = await enqueue(baseUrl, "endpoint/echo-worker", { v: 20 });
        if (!enqueued) throw new Error("enqueue failed");
        await pollWorker(baseUrl, "endpoint/echo-worker", enqueued.runId);
        const cancelResp = await httpPostFull(
          workerRunUrl(baseUrl, "endpoint/echo-worker", enqueued.runId, "cancel"),
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
        const enqueued = await enqueue(baseUrl, "lifecycle/always-fail-worker", {});
        if (!enqueued) throw new Error("enqueue failed");
        await pollWorker(baseUrl, "lifecycle/always-fail-worker", enqueued.runId, 200);
        const cancelResp = await httpPostFull(
          workerRunUrl(baseUrl, "lifecycle/always-fail-worker", enqueued.runId, "cancel"),
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
        const enqueued = await enqueue(baseUrl, "lifecycle/slow-worker", { sleepMs: 10_000 });
        if (!enqueued) throw new Error("enqueue failed");
        const r1 = await httpPostFull(
          workerRunUrl(baseUrl, "lifecycle/slow-worker", enqueued.runId, "cancel"),
        );
        if (r1.status !== 200)
          throw new Error(`first cancel returned ${r1.status}`);
        const r2 = await httpPostFull(
          workerRunUrl(baseUrl, "lifecycle/slow-worker", enqueued.runId, "cancel"),
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
          workerRunUrl(baseUrl, "endpoint/echo-worker", fakeId, "cancel"),
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
            httpPostFull(workerUrl(baseUrl, "endpoint/echo-worker"), { concurrent: true }),
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
        const enqueued = await enqueue(baseUrl, "lifecycle/slow-worker", { sleepMs: 2_000 });
        if (!enqueued) throw new Error("enqueue failed");
        await sleep(100);
        const N = 5;
        const responses = await Promise.all(
          Array.from({ length: N }, () =>
            httpGetFull(
              workerRunUrl(baseUrl, "lifecycle/slow-worker", enqueued.runId, "status"),
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
        const enqueued = await enqueue(baseUrl, "lifecycle/slow-worker", { sleepMs: 10_000 });
        if (!enqueued) throw new Error("enqueue failed");
        const [r1, r2] = await Promise.all([
          httpPostFull(
            workerRunUrl(baseUrl, "lifecycle/slow-worker", enqueued.runId, "cancel"),
          ),
          httpPostFull(
            workerRunUrl(baseUrl, "lifecycle/slow-worker", enqueued.runId, "cancel"),
          ),
        ]);
        if (r1.status === 500 || r2.status === 500)
          throw new Error(`race condition caused 500: ${r1.status} / ${r2.status}`);
        const statusResp = await httpGetFull(
          workerRunUrl(baseUrl, "lifecycle/slow-worker", enqueued.runId, "status"),
        );
        const st = (statusResp.body?.status ?? (statusResp.body?.meta as Record<string, unknown>)?.["status"]) as string | undefined;
        if (st !== "cancelled")
          throw new Error(`expected cancelled after concurrent cancel, got "${String(st)}"`);
      },
    },
  ];
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
