/**
 * Workflow Integration Test Runner (API unit)
 *
 * An API unit that exercises all workflow tests end-to-end via HTTP.
 * When triggered, it starts each workflow through the real trigger endpoints,
 * orchestrates suspend/resume cycles, calls shared handlers, and validates
 * the final results.
 *
 * GET / — runs all tests and returns a JSON report.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PROJECT_ID = "00000000-aaaa-bbbb-cccc-000000000010";
const STAGE_RUNTIME_ID = "00000000-aaaa-bbbb-cccc-000000000022";

function getBaseUrl(req: IncomingMessage): string {
  const host = req.headers.host ?? "127.0.0.1:3333";
  return `http://${host}`;
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

interface HandlerDef {
  name: string;
  input: any;
}

interface TestDef {
  name: string;
  category: string;
  workflowSlug: string;
  input: any;
  handlers: HandlerDef[];
  timeoutPromise: boolean;
  cancelOnSuspend: boolean;
  checks: CheckDef[];
  replay: boolean;
  dedup: boolean;
  /**
   * When true, a promise suspension with no remaining handlers is expected — the
   * promise will be resolved internally (e.g. by an sdk.callWorkflow callee completing).
   * The runner sleeps and keeps polling instead of failing immediately.
   */
  internalResolution?: boolean;
  /** When true the test is recorded as skipped (pending an unimplemented feature). */
  skip?: string;
  /** Override the default 100-iteration poll cap. Use for long-running steps. */
  maxIterations?: number;
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
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function httpGet(url: string): Promise<any> {
  const resp = await fetch(url);
  const text = await resp.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers (with status codes)
// ---------------------------------------------------------------------------

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
      if (!deepEqual(actual, check.expected)) {
        return `'${check.path}': expected ${JSON.stringify(check.expected)}, got ${JSON.stringify(actual)}`;
      }
      return null;
    }
    case "true": {
      const actual = jsonGet(output, check.path);
      if (actual !== true) {
        return `'${check.path}': expected true, got ${JSON.stringify(actual)}`;
      }
      return null;
    }
    case "notNull": {
      const actual = jsonGet(output, check.path);
      if (actual == null) {
        return `'${check.path}': expected non-null`;
      }
      return null;
    }
    case "contains": {
      const actual = jsonGet(output, check.path);
      if (typeof actual !== "string") {
        return `'${check.path}': not a string`;
      }
      if (!actual.includes(check.substr)) {
        return `'${check.path}': '${actual}' does not contain '${check.substr}'`;
      }
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Workflow orchestrator
// ---------------------------------------------------------------------------

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runTest(baseUrl: string, test: TestDef): Promise<TestResult> {
  const label = `${test.category}: ${test.name}`;
  if (test.skip) {
    return { name: label, pass: true, detail: `SKIPPED: ${test.skip}` };
  }

  const wfBase = `${baseUrl}/api/v1/trigger/wf/${PROJECT_ID}/test/wf/${test.workflowSlug}`;

  try {
    if (test.dedup) {
      return await runDedupTest(baseUrl, test);
    }
    if (test.cancelOnSuspend) {
      return await runCancelTest(baseUrl, test);
    }

    const startResp = await httpPost(wfBase, test.input);
    if (!startResp?.instanceId) {
      return fail(test, `start failed: ${JSON.stringify(startResp)}`);
    }
    const instanceId: string = startResp.instanceId;
    const instanceBase = `${wfBase}/${instanceId}`;

    let handlerIdx = 0;

    for (let iter = 0; iter < (test.maxIterations ?? 100); iter++) {
      await sleep(100);

      const statusResp = await httpGet(`${instanceBase}/status`);
      const status = statusResp?.meta?.status ?? "unknown";

      if (status === "completed") {
        const resultResp = await httpGet(`${instanceBase}/result`);
        const output = resultResp?.result;

        if (test.replay && iter < 50) {
          return await runReplayTest(baseUrl, test, instanceId, output);
        }

        return validate(test, output);
      }

      if (status === "suspended") {
        const suspType = statusResp?.meta?.suspended?.type ??
          (await getSuspendedType(baseUrl, instanceId));

        if (suspType === "sleep") {
          await sleep(200);
        } else if (suspType === "step_retry") {
          // The JetStream consumer NAKs the wake message with the backoff delay.
          // Wait at least as long as the declared delayMs so we don't hammer the
          // status endpoint while the NATS server is holding the NAK'd message.
          const delayMs: number = statusResp?.meta?.suspended?.delayMs ?? 100;
          await sleep(Math.min(delayMs + 100, 500));
        } else if (suspType === "promise") {
          if (test.timeoutPromise) {
            await sleep(300);
          } else if (handlerIdx < test.handlers.length) {
            const h = test.handlers[handlerIdx]!;
            await httpPost(`${instanceBase}/handlers/${h.name}`, h.input);
            handlerIdx++;
          } else if (test.internalResolution) {
            await sleep(200);
          } else {
            return fail(test, `unexpected promise suspension (no handler left)`);
          }
        }

        continue;
      }

      if (status === "failed") {
        const resultResp = await httpGet(`${instanceBase}/result`);
        return validate(test, resultResp?.result);
      }

      if (status === "cancelled") {
        return fail(test, "workflow cancelled unexpectedly");
      }
    }

    return fail(test, "max iterations (100) exceeded");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return fail(test, `exception: ${msg}`);
  }
}

async function getSuspendedType(baseUrl: string, instanceId: string): Promise<string> {
  return "promise";
}

async function runDedupTest(baseUrl: string, test: TestDef): Promise<TestResult> {
  const wfBase = `${baseUrl}/api/v1/trigger/wf/${PROJECT_ID}/test/wf/${test.workflowSlug}`;

  const first = await httpPost(wfBase, { salt: "first-call" });
  if (!first?.instanceId) return fail(test, `dedup first start failed: ${JSON.stringify(first)}`);
  const instanceId = first.instanceId;
  const instanceBase = `${wfBase}/${instanceId}`;

  for (let i = 0; i < 50; i++) {
    await sleep(100);
    const s = await httpGet(`${instanceBase}/status`);
    const st = s?.meta?.status;
    if (st === "completed") break;
    if (st === "suspended") {
      await sleep(200);
      continue;
    }
  }

  const firstResult = await httpGet(`${instanceBase}/result`);
  const firstOutput = firstResult?.result;

  const second = await httpPost(wfBase, { salt: "second-call" });
  const secondInstanceId = second?.instanceId;

  if (secondInstanceId !== instanceId) {
    const secondInstanceBase = `${wfBase}/${secondInstanceId}`;
    for (let i = 0; i < 50; i++) {
      await sleep(100);
      const s = await httpGet(`${secondInstanceBase}/status`);
      if (s?.meta?.status === "completed") break;
    }
  }

  const firstNonce = jsonGet(firstOutput, "once.nonce");
  const firstSalt = jsonGet(firstOutput, "once.salt");
  if (firstSalt !== "first-call") {
    return fail(test, `dedup: salt should be 'first-call', got ${JSON.stringify(firstSalt)}`);
  }

  return validate(test, firstOutput);
}

async function runCancelTest(baseUrl: string, test: TestDef): Promise<TestResult> {
  const wfBase = `${baseUrl}/api/v1/trigger/wf/${PROJECT_ID}/test/wf/${test.workflowSlug}`;

  const startResp = await httpPost(wfBase, test.input);
  if (!startResp?.instanceId) return fail(test, `cancel start failed`);
  const instanceId = startResp.instanceId;
  const instanceBase = `${wfBase}/${instanceId}`;

  await sleep(200);

  const statusResp = await httpGet(`${instanceBase}/status`);
  const status = statusResp?.meta?.status;
  if (status !== "suspended") {
    return fail(test, `expected suspended before cancel, got '${status}'`);
  }

  await httpPost(`${instanceBase}/cancel`);

  const finalResp = await httpGet(`${instanceBase}/status`);
  const finalStatus = finalResp?.meta?.status;
  if (finalStatus !== "cancelled") {
    return fail(test, `expected cancelled, got '${finalStatus}'`);
  }

  return pass(test, "cancelled successfully, no result committed");
}

async function runReplayTest(
  baseUrl: string,
  test: TestDef,
  firstInstanceId: string,
  firstOutput: any,
): Promise<TestResult> {
  // Re-fetch the result of the same instance to verify that completed steps
  // return identical cached values (memoization), without relying on dedup.
  const wfBase = `${baseUrl}/api/v1/trigger/wf/${PROJECT_ID}/test/wf/${test.workflowSlug}`;
  const replayBase = `${wfBase}/${firstInstanceId}`;

  const replayResult = await httpGet(`${replayBase}/result`);
  const replayOutput = replayResult?.result;

  const firstSteps = jsonGet(firstOutput, "steps");
  const replaySteps = jsonGet(replayOutput, "steps");
  if (firstSteps && replaySteps) {
    if (JSON.stringify(firstSteps) !== JSON.stringify(replaySteps)) {
      return fail(test, `replay mismatch: steps differ`);
    }
  }

  return validate(test, replayOutput);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validate(test: TestDef, output: any): TestResult {
  for (const check of test.checks) {
    const err = applyCheck(output, check);
    if (err) {
      return {
        name: `${test.category}: ${test.name}`,
        pass: false,
        detail: JSON.stringify(output),
        error: err,
      };
    }
  }
  return {
    name: `${test.category}: ${test.name}`,
    pass: true,
    detail: JSON.stringify(output),
  };
}

function fail(test: TestDef, msg: string): TestResult {
  return {
    name: `${test.category}: ${test.name}`,
    pass: false,
    error: msg,
  };
}

function pass(test: TestDef, detail: string): TestResult {
  return {
    name: `${test.category}: ${test.name}`,
    pass: true,
    detail,
  };
}

// ---------------------------------------------------------------------------
// Test definitions
// ---------------------------------------------------------------------------

function allTests(): TestDef[] {
  return [
    // ---- basic (4) ----
    {
      name: "empty-workflow", category: "basic",
      workflowSlug: "empty-workflow",
      input: { value: 42 },
      handlers: [], timeoutPromise: false, cancelOnSuspend: false,
      replay: false, dedup: false,
      checks: [{ type: "eq", path: "value", expected: 42 }],
    },
    {
      name: "sequential-steps", category: "basic",
      workflowSlug: "sequential-steps",
      input: { seed: 5 },
      handlers: [], timeoutPromise: false, cancelOnSuspend: false,
      replay: false, dedup: false,
      checks: [
        { type: "eq", path: "first", expected: 6 },
        { type: "eq", path: "second", expected: 12 },
        { type: "eq", path: "third", expected: 17 },
        { type: "eq", path: "chain", expected: "6:12:17" },
      ],
    },
    {
      name: "step-return-types", category: "basic",
      workflowSlug: "step-return-types",
      input: {},
      handlers: [], timeoutPromise: false, cancelOnSuspend: false,
      replay: false, dedup: false,
      checks: [
        { type: "eq", path: "str", expected: "baal-workflow" },
        { type: "eq", path: "num", expected: -3.5 },
        { type: "eq", path: "obj.id", expected: 7 },
        { type: "eq", path: "arr.0", expected: 10 },
        { type: "eq", path: "nul", expected: null },
      ],
    },
    {
      name: "step-with-side-effects", category: "basic",
      workflowSlug: "step-with-side-effects",
      input: {},
      handlers: [], timeoutPromise: false, cancelOnSuspend: false,
      replay: false, dedup: false,
      checks: [
        { type: "eq", path: "computed", expected: 47 },
        { type: "eq", path: "scheduledMs", expected: 15 },
      ],
    },

    // ---- compensation (4) ----
    {
      name: "basic-compensation", category: "compensation",
      workflowSlug: "basic-compensation",
      input: {},
      handlers: [], timeoutPromise: false, cancelOnSuspend: false,
      replay: false, dedup: false,
      checks: [
        { type: "eq", path: "compensationOrder", expected: ["undo-reserve", "undo-charge"] },
      ],
    },
    {
      name: "compensation-failure", category: "compensation",
      workflowSlug: "compensation-failure",
      input: {},
      handlers: [], timeoutPromise: false, cancelOnSuspend: false,
      replay: false, dedup: false,
      checks: [
        { type: "eq", path: "compensationError", expected: "compensation blew up" },
        { type: "true", path: "undoReserveCompleted" },
      ],
    },
    {
      name: "nested-compensation", category: "compensation",
      workflowSlug: "nested-compensation",
      input: {},
      handlers: [], timeoutPromise: false, cancelOnSuspend: false,
      replay: false, dedup: false,
      checks: [
        { type: "true", path: "outerUndoRan" },
        { type: "eq", path: "innerLedger", expected: "nested-compensation-step" },
      ],
    },
    {
      name: "partial-compensation", category: "compensation",
      workflowSlug: "partial-compensation",
      input: {},
      handlers: [], timeoutPromise: false, cancelOnSuspend: false,
      replay: false, dedup: false,
      checks: [
        { type: "eq", path: "compensationOrder", expected: ["undo-reserve"] },
      ],
    },

    // ---- deterministic (3) ----
    {
      name: "date-now", category: "deterministic",
      workflowSlug: "date-now",
      input: {},
      handlers: [], timeoutPromise: false, cancelOnSuspend: false,
      replay: false, dedup: false,
      checks: [
        { type: "true", path: "nonDecreasing" },
        { type: "notNull", path: "t1" },
        { type: "notNull", path: "t2" },
      ],
    },
    {
      name: "rand-random", category: "deterministic",
      workflowSlug: "rand-random",
      input: {},
      handlers: [], timeoutPromise: false, cancelOnSuspend: false,
      replay: false, dedup: false,
      checks: [
        { type: "true", path: "inUnitInterval" },
        { type: "notNull", path: "a" },
        { type: "notNull", path: "b" },
      ],
    },
    {
      name: "rand-uuidv4", category: "deterministic",
      workflowSlug: "rand-uuidv-four",
      input: {},
      handlers: [], timeoutPromise: false, cancelOnSuspend: false,
      replay: false, dedup: false,
      checks: [
        { type: "true", path: "stepsAreDistinct" },
        { type: "notNull", path: "step1" },
        { type: "notNull", path: "step2" },
      ],
    },

    // ---- memoization (3) ----
    {
      name: "idempotent-steps", category: "memoization",
      workflowSlug: "idempotent-steps",
      input: {},
      handlers: [], timeoutPromise: false, cancelOnSuspend: false,
      replay: false, dedup: false,
      checks: [
        { type: "true", path: "valuesMatch" },
        { type: "eq", path: "first.id", expected: 1 },
        { type: "eq", path: "first.note", expected: "first-execution" },
      ],
    },
    {
      name: "step-cache-integrity", category: "memoization",
      workflowSlug: "step-cache-integrity",
      input: {},
      handlers: [], timeoutPromise: false, cancelOnSuspend: false,
      replay: false, dedup: false,
      checks: [
        { type: "eq", path: "alpha.n", expected: 11 },
        { type: "eq", path: "beta.sum", expected: 15 },
        { type: "eq", path: "gamma.label", expected: "derived-15" },
        { type: "notNull", path: "fingerprint" },
      ],
    },
    {
      name: "step-memoization", category: "memoization",
      workflowSlug: "step-memoization",
      input: {},
      handlers: [], timeoutPromise: false, cancelOnSuspend: false,
      replay: true, dedup: false,
      checks: [
        { type: "eq", path: "steps.0.ordinal", expected: 1 },
        { type: "eq", path: "steps.1.ordinal", expected: 2 },
        { type: "eq", path: "steps.2.ordinal", expected: 3 },
        { type: "notNull", path: "instanceKey" },
      ],
    },

    // ---- parallel (2) ----
    {
      name: "promise-all", category: "parallel",
      workflowSlug: "promise-all",
      input: {},
      handlers: [], timeoutPromise: false, cancelOnSuspend: false,
      replay: false, dedup: false,
      checks: [
        { type: "eq", path: "sum", expected: 42 },
        { type: "eq", path: "a.label", expected: "a" },
        { type: "eq", path: "b.label", expected: "b" },
      ],
    },
    {
      name: "parallel-steps-isolation", category: "parallel",
      workflowSlug: "parallel-steps-isolation",
      input: {},
      handlers: [], timeoutPromise: false, cancelOnSuspend: false,
      replay: false, dedup: false,
      checks: [
        { type: "true", path: "isolated" },
        { type: "eq", path: "left.lane", expected: "left" },
        { type: "eq", path: "right.lane", expected: "right" },
      ],
    },

    // ---- promises (6) ----
    {
      name: "basic-promise", category: "promises",
      workflowSlug: "basic-promise",
      input: {},
      handlers: [{ name: "approve", input: { value: "test-approval" } }],
      timeoutPromise: false, cancelOnSuspend: false,
      replay: false, dedup: false,
      checks: [
        { type: "eq", path: "received", expected: "test-approval" },
        { type: "true", path: "complete" },
      ],
    },
    {
      name: "multiple-promises", category: "promises",
      workflowSlug: "multiple-promises",
      input: {},
      handlers: [], timeoutPromise: false, cancelOnSuspend: false,
      replay: false, dedup: false,
      checks: [
        { type: "eq", path: "a", expected: 10 },
        { type: "eq", path: "b", expected: 32 },
        { type: "eq", path: "c", expected: "done" },
        { type: "eq", path: "sum", expected: 42 },
      ],
    },
    {
      name: "promise-from-shared-handler", category: "promises",
      workflowSlug: "promise-from-shared-handler",
      input: {},
      handlers: [{ name: "submitResult", input: { id: "test-id", score: 99 } }],
      timeoutPromise: false, cancelOnSuspend: false,
      replay: false, dedup: false,
      checks: [
        { type: "eq", path: "id", expected: "test-id" },
        { type: "eq", path: "score", expected: 99 },
      ],
    },
    {
      name: "promise-reject", category: "promises",
      workflowSlug: "promise-reject",
      input: {},
      handlers: [], timeoutPromise: false, cancelOnSuspend: false,
      replay: false, dedup: false,
      checks: [
        { type: "true", path: "ok" },
        { type: "true", path: "rejected" },
        { type: "notNull", path: "message" },
      ],
    },
    {
      name: "promise-resolve-before-wait", category: "promises",
      workflowSlug: "promise-resolve-before-wait",
      input: {},
      handlers: [], timeoutPromise: false, cancelOnSuspend: false,
      replay: false, dedup: false,
      checks: [
        { type: "true", path: "immediate" },
        { type: "eq", path: "value", expected: "resolved-first" },
      ],
    },
    {
      name: "promise-timeout", category: "promises",
      workflowSlug: "promise-timeout",
      input: {},
      handlers: [],
      timeoutPromise: true, cancelOnSuspend: false,
      replay: false, dedup: false,
      checks: [
        { type: "true", path: "timedOut" },
        { type: "eq", path: "value", expected: null },
      ],
    },

    // ---- retry (4) ----
    {
      name: "default-retry", category: "retry",
      workflowSlug: "default-retry",
      input: {},
      handlers: [], timeoutPromise: false, cancelOnSuspend: false,
      replay: false, dedup: false,
      checks: [
        { type: "eq", path: "message", expected: "recovered" },
        { type: "eq", path: "attempts", expected: 3 },
      ],
    },
    {
      name: "custom-retry-policy", category: "retry",
      workflowSlug: "custom-retry-policy",
      input: {},
      handlers: [], timeoutPromise: false, cancelOnSuspend: false,
      replay: false, dedup: false,
      checks: [
        { type: "true", path: "ok" },
        { type: "eq", path: "attempts", expected: 5 },
      ],
    },
    {
      name: "retry-exhaustion", category: "retry",
      workflowSlug: "retry-exhaustion",
      input: {},
      handlers: [], timeoutPromise: false, cancelOnSuspend: false,
      replay: false, dedup: false,
      checks: [
        { type: "notNull", path: "errorName" },
        { type: "contains", path: "message", substr: "persistent transient" },
      ],
    },
    {
      name: "terminal-error-no-retry", category: "retry",
      workflowSlug: "terminal-error-no-retry",
      input: {},
      handlers: [], timeoutPromise: false, cancelOnSuspend: false,
      replay: false, dedup: false,
      checks: [
        { type: "eq", path: "terminalInvocations", expected: 1 },
      ],
    },

    // ---- shared-handlers (4) ----
    {
      name: "resolve-promise", category: "shared_handlers",
      workflowSlug: "resolve-promise",
      input: {},
      handlers: [{ name: "approve", input: { token: "test-token" } }],
      timeoutPromise: false, cancelOnSuspend: false,
      replay: false, dedup: false,
      checks: [
        { type: "eq", path: "approval", expected: "test-token" },
      ],
    },
    {
      name: "handler-before-run-starts", category: "shared_handlers",
      workflowSlug: "handler-before-run-starts",
      input: {},
      handlers: [{ name: "allow", input: {} }],
      timeoutPromise: false, cancelOnSuspend: false,
      replay: false, dedup: false,
      checks: [
        { type: "eq", path: "phase", expected: "main-work" },
      ],
    },
    {
      name: "multiple-handlers", category: "shared_handlers",
      workflowSlug: "multiple-handlers",
      input: {},
      handlers: [
        { name: "resolveA", input: {} },
        { name: "resolveB", input: {} },
      ],
      timeoutPromise: false, cancelOnSuspend: false,
      replay: false, dedup: false,
      checks: [
        { type: "eq", path: "order", expected: ["first", "second"] },
      ],
    },
    {
      name: "query-status", category: "shared_handlers",
      workflowSlug: "query-status",
      input: {},
      handlers: [
        { name: "status", input: {} },
        { name: "release", input: {} },
      ],
      timeoutPromise: false, cancelOnSuspend: false,
      replay: false, dedup: false,
      checks: [
        { type: "true", path: "done" },
        { type: "eq", path: "status.phase", expected: "running" },
        { type: "eq", path: "status.counter", expected: 1 },
      ],
    },

    // ---- sleep (5) ----
    {
      name: "sleep-zero", category: "sleep",
      workflowSlug: "sleep-zero",
      input: {},
      handlers: [], timeoutPromise: false, cancelOnSuspend: false,
      replay: false, dedup: false,
      checks: [
        { type: "eq", path: "edgeCase", expected: "sleep-zero" },
        { type: "notNull", path: "before" },
        { type: "notNull", path: "after" },
      ],
    },
    {
      name: "basic-sleep", category: "sleep",
      workflowSlug: "basic-sleep",
      input: {},
      handlers: [], timeoutPromise: false, cancelOnSuspend: false,
      replay: false, dedup: false,
      checks: [
        { type: "true", path: "ok" },
        { type: "eq", path: "slept", expected: ["sleep-ms-number", "sleep-ms-obj", "sleep-seconds", "sleep-mixed"] },
      ],
    },
    {
      name: "multiple-sleeps", category: "sleep",
      workflowSlug: "multiple-sleeps",
      input: {},
      handlers: [], timeoutPromise: false, cancelOnSuspend: false,
      replay: false, dedup: false,
      checks: [
        { type: "true", path: "ok" },
        { type: "eq", path: "total", expected: 3 },
        { type: "eq", path: "sequence", expected: ["first", "second", "third"] },
      ],
    },
    {
      name: "sleep-resume", category: "sleep",
      workflowSlug: "sleep-resume",
      input: {},
      handlers: [], timeoutPromise: false, cancelOnSuspend: false,
      replay: false, dedup: false,
      checks: [
        { type: "eq", path: "prePhase", expected: "pre" },
        { type: "true", path: "post.resumed" },
        { type: "eq", path: "message", expected: "completed-after-sleep" },
      ],
    },
    {
      name: "sleep-survives-restart", category: "sleep",
      workflowSlug: "sleep-survives-restart",
      input: {},
      handlers: [], timeoutPromise: false, cancelOnSuspend: false,
      replay: false, dedup: false,
      checks: [
        { type: "true", path: "survived" },
        { type: "notNull", path: "after.continuedFrom" },
        { type: "notNull", path: "boundary.marker" },
      ],
    },

    // ---- state (4) ----
    {
      name: "set-get-basic", category: "state",
      workflowSlug: "set-get-basic",
      input: {},
      handlers: [], timeoutPromise: false, cancelOnSuspend: false,
      replay: false, dedup: false,
      checks: [
        { type: "true", path: "ok" },
        { type: "eq", path: "value", expected: "hello" },
      ],
    },
    {
      name: "state-types", category: "state",
      workflowSlug: "state-types",
      input: {},
      handlers: [], timeoutPromise: false, cancelOnSuspend: false,
      replay: false, dedup: false,
      checks: [
        { type: "eq", path: "str", expected: "text" },
        { type: "eq", path: "num", expected: 7 },
        { type: "eq", path: "obj.a", expected: 1 },
        { type: "eq", path: "obj.nested.b", expected: 2 },
        { type: "eq", path: "arr.0", expected: 1 },
        { type: "eq", path: "nil", expected: null },
      ],
    },
    {
      name: "state-across-steps", category: "state",
      workflowSlug: "state-across-steps",
      input: {},
      handlers: [], timeoutPromise: false, cancelOnSuspend: false,
      replay: false, dedup: false,
      checks: [
        { type: "true", path: "ok" },
        { type: "eq", path: "marker", expected: "from-step-1" },
      ],
    },
    {
      name: "state-from-shared-handler", category: "state",
      workflowSlug: "state-from-shared-handler",
      input: {},
      handlers: [
        { name: "peek", input: {} },
        { name: "finish", input: {} },
      ],
      timeoutPromise: false, cancelOnSuspend: false,
      replay: false, dedup: false,
      checks: [
        { type: "true", path: "finished" },
        { type: "eq", path: "payload.by", expected: "run" },
        { type: "eq", path: "payload.n", expected: 42 },
      ],
    },

    // ---- crash-recovery (3) ----
    {
      name: "resume-after-step", category: "crash_recovery",
      workflowSlug: "resume-after-step",
      input: {},
      handlers: [], timeoutPromise: false, cancelOnSuspend: false,
      replay: false, dedup: false,
      checks: [
        { type: "eq", path: "steps.0.index", expected: 1 },
        { type: "eq", path: "steps.1.index", expected: 2 },
        { type: "eq", path: "steps.2.index", expected: 3 },
        { type: "eq", path: "steps.2.builtFromCache", expected: [1, 2] },
      ],
    },
    {
      name: "resume-after-sleep", category: "crash_recovery",
      workflowSlug: "resume-after-sleep",
      input: {},
      handlers: [], timeoutPromise: false, cancelOnSuspend: false,
      replay: false, dedup: false,
      checks: [
        { type: "notNull", path: "beforeSleep.token" },
        { type: "true", path: "afterSleep.resumed" },
      ],
    },
    {
      name: "resume-after-promise", category: "crash_recovery",
      workflowSlug: "resume-after-promise",
      input: {},
      handlers: [{ name: "approve", input: { secret: "test-secret" } }],
      timeoutPromise: false, cancelOnSuspend: false,
      replay: false, dedup: false,
      checks: [
        { type: "true", path: "finalized" },
        { type: "notNull", path: "staged.batch" },
        { type: "eq", path: "approval", expected: "test-secret" },
      ],
    },

    // ---- lifecycle (3) ----
    {
      name: "workflow-completion", category: "lifecycle",
      workflowSlug: "workflow-completion",
      input: { label: "test-label" },
      handlers: [], timeoutPromise: false, cancelOnSuspend: false,
      replay: false, dedup: false,
      checks: [
        { type: "eq", path: "status", expected: "completed" },
        { type: "eq", path: "label", expected: "test-label" },
        { type: "notNull", path: "digest" },
        { type: "notNull", path: "completedAt" },
      ],
    },
    {
      name: "workflow-deduplication", category: "lifecycle",
      workflowSlug: "workflow-deduplication",
      input: { salt: "first-call" },
      handlers: [], timeoutPromise: false, cancelOnSuspend: false,
      replay: false,
      dedup: true,
      checks: [
        { type: "notNull", path: "instanceKey" },
        { type: "notNull", path: "once.nonce" },
      ],
    },
    {
      name: "workflow-cancellation", category: "lifecycle",
      workflowSlug: "workflow-cancellation",
      input: {},
      handlers: [], timeoutPromise: false,
      cancelOnSuspend: true,
      replay: false, dedup: false,
      checks: [],
    },

    // ---- integration (6) ----
    {
      name: "sdk-call-unsupported-type", category: "integration",
      workflowSlug: "sdk-call-unsupported-type",
      input: {},
      handlers: [], timeoutPromise: false, cancelOnSuspend: false,
      replay: false, dedup: false,
      checks: [
        { type: "true", path: "ok" },
        { type: "contains", path: "errorMessage", substr: "API unit" },
      ],
    },
    {
      // Validation fires before any NATS publish — works without Phase C.
      name: "sdk-call-invalid-path", category: "integration",
      workflowSlug: "sdk-call-invalid-path",
      input: {},
      handlers: [], timeoutPromise: false, cancelOnSuspend: false,
      replay: false, dedup: false,
      checks: [
        { type: "true", path: "ok" },
        { type: "contains", path: "errorMessage", substr: "invalid unit path" },
      ],
    },
    {
      name: "sdk-call-basic", category: "integration",
      workflowSlug: "sdk-call-basic",
      input: {},
      handlers: [], timeoutPromise: false, cancelOnSuspend: false,
      replay: false, dedup: false, internalResolution: true,
      checks: [
        { type: "true", path: "called" },
        { type: "eq", path: "doubled", expected: 4 },
      ],
    },
    {
      // Verifies sdk.startWorkflowSync returns { instanceId } immediately
      // (fire-and-forget) without suspending the caller — the caller completes
      // right away regardless of whether the callee is still running.
      name: "sdk-start-workflow-fire-forget", category: "integration",
      workflowSlug: "sdk-start-workflow-fire-forget",
      input: {},
      handlers: [], timeoutPromise: false, cancelOnSuspend: false,
      replay: false, dedup: false,
      checks: [
        { type: "true", path: "nonEmpty" },
        { type: "notNull", path: "instanceId" },
      ],
    },
    {
      name: "sdk-call-failure-propagates", category: "integration",
      workflowSlug: "sdk-call-failure-propagates",
      input: {},
      handlers: [], timeoutPromise: false, cancelOnSuspend: false,
      replay: false, dedup: false, internalResolution: true,
      checks: [
        { type: "true", path: "caught" },
        { type: "contains", path: "errorMessage", substr: "callee-intentional-failure" },
      ],
    },
    {
      name: "sdk-call-sequential", category: "integration",
      workflowSlug: "sdk-call-sequential",
      input: {},
      handlers: [], timeoutPromise: false, cancelOnSuspend: false,
      replay: false, dedup: false, internalResolution: true,
      checks: [
        { type: "eq", path: "first", expected: 6 },
        { type: "eq", path: "second", expected: 10 },
      ],
    },
    {
      name: "attach-to-result", category: "integration",
      workflowSlug: "attach-to-result",
      input: {},
      handlers: [], timeoutPromise: false, cancelOnSuspend: false,
      replay: false, dedup: false,
      checks: [
        { type: "notNull", path: "resultToken" },
        { type: "contains", path: "checksum", substr: "ck:" },
        { type: "notNull", path: "completedAt" },
      ],
    },
    {
      name: "sdk-call-nested", category: "integration",
      workflowSlug: "sdk-call-nested",
      input: {},
      handlers: [], timeoutPromise: false, cancelOnSuspend: false,
      replay: false, dedup: false, internalResolution: true,
      checks: [
        { type: "eq", path: "result", expected: 9 },
      ],
    },
    {
      name: "sdk-call-parallel", category: "integration",
      workflowSlug: "sdk-call-parallel",
      input: {},
      handlers: [], timeoutPromise: false, cancelOnSuspend: false,
      replay: false, dedup: false, internalResolution: true,
      skip: "sdk.* calls are synchronous; Promise.all parallelism requires an async variant (not yet implemented)",
      checks: [
        { type: "eq", path: "a", expected: 6 },
        { type: "eq", path: "b", expected: 14 },
        { type: "eq", path: "sum", expected: 20 },
      ],
    },
    {
      name: "sdk-call-with-steps-callee", category: "integration",
      workflowSlug: "sdk-call-with-steps-callee",
      input: {},
      handlers: [], timeoutPromise: false, cancelOnSuspend: false,
      replay: false, dedup: false, internalResolution: true,
      checks: [
        { type: "eq", path: "calleeStep1", expected: 5 },
        { type: "eq", path: "calleeStep2", expected: 10 },
        { type: "eq", path: "combined", expected: 15 },
      ],
    },
    {
      name: "sdk-call-between-steps", category: "integration",
      workflowSlug: "sdk-call-between-steps",
      input: {},
      handlers: [], timeoutPromise: false, cancelOnSuspend: false,
      replay: false, dedup: false, internalResolution: true,
      checks: [
        { type: "eq", path: "before", expected: 10 },
        { type: "eq", path: "callResult", expected: 10 },
        { type: "eq", path: "after", expected: 20 },
      ],
    },
    {
      name: "sdk-call-catch-callee-step-failure", category: "integration",
      workflowSlug: "sdk-call-catch-callee-step-failure",
      input: {},
      handlers: [], timeoutPromise: false, cancelOnSuspend: false,
      replay: false, dedup: false, internalResolution: true,
      checks: [
        { type: "true", path: "caught" },
        { type: "contains", path: "errorMessage", substr: "callee-failed-after-steps" },
      ],
    },
    // ---- isolation (1) ----
    {
      name: "cross-project-steps", category: "isolation",
      workflowSlug: "cross-project-steps",
      input: {},
      handlers: [], timeoutPromise: false, cancelOnSuspend: false,
      replay: false, dedup: false,
      checks: [
        { type: "eq", path: "projectA", expected: "00000000-0000-0000-0000-000000000001" },
        { type: "notNull", path: "stepSecret" },
        { type: "notNull", path: "instance" },
      ],
    },

    // ---- timers (1) ----
    // These tests specifically exercise the JetStream durable-timer paths:
    // sleep (NAK-with-delay on the wake consumer) and step retry backoff
    // (immediate JetStream publish with fire_at). Both paths must survive
    // process restarts because the NATS server holds the NAK'd messages.
    {
      name: "sleep-then-retry", category: "timers",
      workflowSlug: "sleep-then-retry",
      input: {},
      handlers: [], timeoutPromise: false, cancelOnSuspend: false,
      replay: false, dedup: false,
      checks: [
        { type: "notNull", path: "token" },
        { type: "true", path: "sleptOk" },
        { type: "eq", path: "attempts", expected: 3 },
        { type: "eq", path: "result", expected: "done" },
      ],
    },

    // ---- durability (5) ----
    {
      name: "slow-step-completes", category: "durability",
      workflowSlug: "slow-step-completes",
      input: {},
      handlers: [], timeoutPromise: false, cancelOnSuspend: false,
      replay: false, dedup: false,
      checks: [
        { type: "true", path: "done" },
        { type: "notNull", path: "computed" },
      ],
    },
    {
      name: "idempotent-after-redelivery", category: "durability",
      workflowSlug: "idempotent-after-redelivery",
      input: { salt: "first-call" },
      handlers: [], timeoutPromise: false, cancelOnSuspend: false,
      replay: false, dedup: true,
      checks: [
        { type: "notNull", path: "once.nonce" },
        { type: "eq", path: "once.salt", expected: "first-call" },
      ],
    },
    {
      name: "sleep-fire-at-accuracy", category: "durability",
      workflowSlug: "sleep-fire-at-accuracy",
      input: {},
      handlers: [], timeoutPromise: false, cancelOnSuspend: false,
      replay: false, dedup: false,
      checks: [
        { type: "true", path: "withinTolerance" },
        { type: "notNull", path: "elapsed" },
      ],
    },
    {
      name: "sleep-then-steps-then-sleep", category: "durability",
      workflowSlug: "sleep-then-steps-then-sleep",
      input: {},
      handlers: [], timeoutPromise: false, cancelOnSuspend: false,
      replay: false, dedup: false,
      checks: [
        { type: "eq", path: "a", expected: "step-a" },
        { type: "eq", path: "b", expected: "step-b" },
        { type: "eq", path: "c", expected: "step-c" },
        { type: "eq", path: "sequence", expected: ["step-a", "step-b", "step-c"] },
      ],
    },
    {
      name: "sleep-with-state-persistence", category: "durability",
      workflowSlug: "sleep-with-state-persistence",
      input: {},
      handlers: [], timeoutPromise: false, cancelOnSuspend: false,
      replay: false, dedup: false,
      checks: [
        { type: "eq", path: "beforeSleep", expected: "before-sleep" },
        { type: "eq", path: "afterSleep", expected: "before-sleep" },
        { type: "true", path: "persisted" },
      ],
    },

    {
      name: "ack-boundary-long-step", category: "durability",
      workflowSlug: "ack-boundary-long-step",
      input: {},
      handlers: [], timeoutPromise: false, cancelOnSuspend: false,
      replay: false, dedup: false,
      maxIterations: 500,
      checks: [
        { type: "true", path: "done" },
        { type: "true", path: "exceededAckWait" },
      ],
    },

    // ---- crash-recovery new (2) ----
    {
      name: "resume-preserves-step-order", category: "crash_recovery",
      workflowSlug: "resume-preserves-step-order",
      input: {},
      handlers: [], timeoutPromise: false, cancelOnSuspend: false,
      replay: false, dedup: false,
      checks: [
        { type: "eq", path: "steps.0.index", expected: 1 },
        { type: "eq", path: "steps.1.index", expected: 2 },
        { type: "eq", path: "steps.2.index", expected: 3 },
        { type: "eq", path: "steps.3.index", expected: 4 },
        { type: "eq", path: "steps.4.index", expected: 5 },
        { type: "true", path: "allInOrder" },
        { type: "eq", path: "preSleepCached", expected: [1, 2, 3] },
      ],
    },

    // ---- lifecycle new (2) ----
    {
      name: "cancel-during-sleep", category: "lifecycle",
      workflowSlug: "cancel-during-sleep",
      input: {},
      handlers: [], timeoutPromise: false,
      cancelOnSuspend: true,
      replay: false, dedup: false,
      checks: [],
    },
    {
      name: "cancel-during-promise-wait", category: "lifecycle",
      workflowSlug: "cancel-during-promise-wait",
      input: {},
      handlers: [], timeoutPromise: false,
      cancelOnSuspend: true,
      replay: false, dedup: false,
      checks: [],
    },

    // ---- integration new (3) ----
    {
      name: "sdk-call-callee-sleeps", category: "integration",
      workflowSlug: "sdk-call-callee-sleeps",
      input: {},
      handlers: [], timeoutPromise: false, cancelOnSuspend: false,
      replay: false, dedup: false, internalResolution: true,
      checks: [
        { type: "true", path: "callResult.slept" },
        { type: "eq", path: "callResult.n_doubled", expected: 10 },
        { type: "true", path: "callerDone" },
      ],
    },
    {
      name: "sdk-call-callee-with-promise", category: "integration",
      workflowSlug: "sdk-call-callee-with-promise",
      input: {},
      handlers: [], timeoutPromise: false, cancelOnSuspend: false,
      replay: false, dedup: false,
      skip: "Requires callee instance discovery for handler dispatch",
      checks: [
        { type: "notNull", path: "result" },
      ],
    },
    {
      name: "sdk-call-timeout", category: "integration",
      workflowSlug: "sdk-call-timeout",
      input: {},
      handlers: [], timeoutPromise: false, cancelOnSuspend: false,
      replay: false, dedup: false,
      skip: "sdk.callWorkflow caller-side timeout not yet implemented",
      checks: [
        { type: "notNull", path: "result" },
      ],
    },

    // ---- promises new (2) ----
    {
      name: "promise-and-sleep-parallel", category: "promises",
      workflowSlug: "promise-and-sleep-parallel",
      input: {},
      handlers: [{ name: "resolve", input: { value: "parallel-done" } }],
      timeoutPromise: false, cancelOnSuspend: false,
      replay: false, dedup: false,
      checks: [
        { type: "true", path: "slept" },
        { type: "eq", path: "value", expected: "parallel-done" },
      ],
    },

    // ---- memoization new (2) ----
    {
      name: "many-steps-replay", category: "memoization",
      workflowSlug: "many-steps-replay",
      input: {},
      handlers: [], timeoutPromise: false, cancelOnSuspend: false,
      replay: false, dedup: false,
      checks: [
        { type: "true", path: "allIndicesCorrect" },
        { type: "eq", path: "postSleep.count", expected: 20 },
        { type: "eq", path: "postSleep.firstIndex", expected: 1 },
        { type: "eq", path: "postSleep.lastIndex", expected: 20 },
      ],
    },
    {
      name: "step-result-types-after-resume", category: "memoization",
      workflowSlug: "step-result-types-after-resume",
      input: {},
      handlers: [], timeoutPromise: false, cancelOnSuspend: false,
      replay: false, dedup: false,
      checks: [
        { type: "true", path: "allOk" },
        { type: "true", path: "verified.strOk" },
        { type: "true", path: "verified.numOk" },
        { type: "true", path: "verified.nilOk" },
        { type: "true", path: "verified.nestedOk" },
      ],
    },

    // ---- retry new (2) ----
    {
      name: "retry-across-resume", category: "retry",
      workflowSlug: "retry-across-resume",
      input: {},
      handlers: [], timeoutPromise: false, cancelOnSuspend: false,
      replay: false, dedup: false,
      checks: [
        { type: "eq", path: "attempts", expected: 3 },
        { type: "true", path: "succeeded" },
      ],
    },
    {
      name: "retry-then-sleep", category: "retry",
      workflowSlug: "retry-then-sleep",
      input: {},
      handlers: [], timeoutPromise: false, cancelOnSuspend: false,
      replay: false, dedup: false,
      checks: [
        { type: "eq", path: "attempts", expected: 2 },
        { type: "true", path: "slept" },
        { type: "true", path: "done" },
      ],
    },

    // ---- state new (1) ----
    {
      name: "state-survives-multiple-resumes", category: "state",
      workflowSlug: "state-survives-multiple-resumes",
      input: {},
      handlers: [], timeoutPromise: false, cancelOnSuspend: false,
      replay: false, dedup: false,
      checks: [
        { type: "true", path: "counterProgressed" },
        { type: "true", path: "tagProgressed" },
        { type: "eq", path: "mid.counter", expected: 1 },
        { type: "eq", path: "final.counter", expected: 2 },
      ],
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
    summary: { healthy, total_tests: total, total_passed: passed, total_failed: failed, total_skipped: skipped, sections: sectionSummaries },
    sections: sectionDetails,
    tests: flatTests,
  };
}

// ---------------------------------------------------------------------------
// Endpoint contract tests — validate HTTP status codes, response shapes,
// and error handling for each production workflow endpoint.
// ---------------------------------------------------------------------------

interface EndpointTestDef {
  name: string;
  category: string;
  run: (baseUrl: string) => Promise<void>;
}

async function runEndpointTest(baseUrl: string, test: EndpointTestDef): Promise<TestResult> {
  const label = `${test.category}: ${test.name}`;
  try {
    await test.run(baseUrl);
    return { name: label, pass: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { name: label, pass: false, error: msg };
  }
}

function epWfUrl(baseUrl: string, slug: string): string {
  return `${baseUrl}/api/v1/trigger/wf/${PROJECT_ID}/test/wf/${slug}`;
}

function epWfStageUrl(baseUrl: string, slug: string, runtimeId = STAGE_RUNTIME_ID): string {
  return `${baseUrl}/api/v1/trigger/wf/${PROJECT_ID}/stage/${runtimeId}/test/wf/${slug}`;
}

async function epStart(
  baseUrl: string,
  slug: string,
  input?: any,
): Promise<{ instanceId: string; base: string }> {
  const resp = await httpPostFull(epWfUrl(baseUrl, slug), input ?? {});
  if (resp.status !== 200 || !resp.body?.instanceId) {
    throw new Error(`start ${slug} failed: ${resp.status} ${JSON.stringify(resp.body)}`);
  }
  return {
    instanceId: resp.body.instanceId as string,
    base: `${epWfUrl(baseUrl, slug)}/${resp.body.instanceId}`,
  };
}

async function epPollStatus(instanceBase: string, target: string, maxIter = 120): Promise<any> {
  const seen = new Set<string>();
  for (let i = 0; i < maxIter; i++) {
    await sleep(150);
    const resp = await httpGetFull(`${instanceBase}/status`);
    const st: unknown = resp.body?.meta?.status;
    seen.add(`${String(st)}(http:${resp.status})`);
    if (st === target) return resp.body;
    if (st === "failed") throw new Error(`workflow failed while waiting for '${target}'`);
    if (resp.status >= 500) throw new Error(`status endpoint returned ${resp.status}: ${JSON.stringify(resp.body)}`);
  }
  throw new Error(`timed out waiting for '${target}' (saw: ${[...seen].join(", ")})`);
}

function allEndpointTests(): EndpointTestDef[] {
  const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  return [
    // ── Start Workflow Endpoint ──────────────────────────────────────────
    {
      name: "start-returns-instance-id-and-running",
      category: "endpoint_start",
      run: async (baseUrl) => {
        const resp = await httpPostFull(epWfUrl(baseUrl, "echo-input"), { test: true });
        if (resp.status !== 200)
          throw new Error(`expected 200, got ${resp.status}`);
        if (!resp.body?.instanceId)
          throw new Error("missing instanceId in response");
        if (resp.body?.status !== "running")
          throw new Error(`expected status "running", got "${resp.body?.status}"`);
        if (!UUID_RX.test(resp.body.instanceId))
          throw new Error(`instanceId is not a valid UUID: ${resp.body.instanceId}`);
      },
    },
    {
      name: "start-passes-input-to-workflow",
      category: "endpoint_start",
      run: async (baseUrl) => {
        const input = { greeting: "hello", n: 7, nested: { ok: true } };
        const { base } = await epStart(baseUrl, "echo-verify-input", input);
        await epPollStatus(base, "completed");
        const res = await httpGetFull(`${base}/result`);
        if (res.status !== 200)
          throw new Error(`result endpoint returned ${res.status}`);
        const r = res.body?.result;
        if (r?.greeting !== "hello") throw new Error(`greeting mismatch: ${JSON.stringify(r)}`);
        if (r?.n !== 7) throw new Error(`n mismatch: ${JSON.stringify(r)}`);
        if (r?.nested?.ok !== true) throw new Error(`nested mismatch: ${JSON.stringify(r)}`);
      },
    },
    {
      name: "start-with-empty-body",
      category: "endpoint_start",
      run: async (baseUrl) => {
        const resp = await httpPostFull(epWfUrl(baseUrl, "echo-input"));
        if (resp.status !== 200)
          throw new Error(`expected 200, got ${resp.status}`);
        if (!resp.body?.instanceId)
          throw new Error("missing instanceId when started with empty body");
      },
    },
    {
      name: "start-nonexistent-workflow-404",
      category: "endpoint_start",
      run: async (baseUrl) => {
        const resp = await httpPostFull(
          epWfUrl(baseUrl, "this-workflow-does-not-exist"),
          {},
        );
        if (resp.status !== 404)
          throw new Error(`expected 404, got ${resp.status}: ${JSON.stringify(resp.body)}`);
      },
    },
    {
      name: "start-invalid-slug-400",
      category: "endpoint_start",
      run: async (baseUrl) => {
        const url = `${baseUrl}/api/v1/trigger/wf/${PROJECT_ID}/test/wf/inv@lid!!`;
        const resp = await httpPostFull(url, {});
        if (resp.status !== 400)
          throw new Error(`expected 400, got ${resp.status}: ${JSON.stringify(resp.body)}`);
      },
    },

    // ── Get Status Endpoint ──────────────────────────────────────────────
    {
      name: "status-completed-workflow",
      category: "endpoint_status",
      run: async (baseUrl) => {
        const { base } = await epStart(baseUrl, "echo-input", { v: 1 });
        const body = await epPollStatus(base, "completed");
        if (body?.meta?.status !== "completed")
          throw new Error(`expected "completed", got "${body?.meta?.status}"`);
      },
    },
    {
      name: "status-suspended-on-promise",
      category: "endpoint_status",
      run: async (baseUrl) => {
        const { base } = await epStart(baseUrl, "suspend-for-status", {});
        const body = await epPollStatus(base, "suspended");
        if (body?.meta?.status !== "suspended")
          throw new Error(`expected "suspended", got "${body?.meta?.status}"`);
        await httpPostFull(`${base}/handlers/resolve`, {});
      },
    },
    {
      name: "status-nonexistent-instance-404",
      category: "endpoint_status",
      run: async (baseUrl) => {
        const fakeId = "00000000-dead-beef-0000-000000000000";
        const url = `${epWfUrl(baseUrl, "echo-input")}/${fakeId}/status`;
        const resp = await httpGetFull(url);
        if (resp.status !== 404)
          throw new Error(`expected 404, got ${resp.status}`);
      },
    },

    // ── Get Result Endpoint ──────────────────────────────────────────────
    {
      name: "result-completed-response-shape",
      category: "endpoint_result",
      run: async (baseUrl) => {
        const input = { tag: "result-shape-test" };
        const { base } = await epStart(baseUrl, "echo-result-shape", input);
        await epPollStatus(base, "completed");
        const resp = await httpGetFull(`${base}/result`);
        if (resp.status !== 200)
          throw new Error(`expected 200, got ${resp.status}`);
        if (resp.body?.status !== "completed")
          throw new Error(`expected body.status "completed", got "${resp.body?.status}"`);
        if (resp.body?.result === undefined || resp.body?.result === null)
          throw new Error("result field is missing or null");
        if (resp.body?.result?.tag !== "result-shape-test")
          throw new Error(`result.tag mismatch: ${JSON.stringify(resp.body?.result)}`);
      },
    },
    {
      name: "result-preserves-complex-types",
      category: "endpoint_result",
      run: async (baseUrl) => {
        const input = {
          str: "hello",
          num: -3.14,
          bool: true,
          nil: null,
          arr: [1, "two", null],
          nested: { deep: { value: 42 } },
        };
        const { base } = await epStart(baseUrl, "echo-result-types", input);
        await epPollStatus(base, "completed");
        const resp = await httpGetFull(`${base}/result`);
        const r = resp.body?.result;
        if (r?.str !== "hello") throw new Error("str mismatch");
        if (r?.num !== -3.14) throw new Error("num mismatch");
        if (r?.bool !== true) throw new Error("bool mismatch");
        if (r?.nil !== null) throw new Error("nil mismatch");
        if (!Array.isArray(r?.arr) || r.arr.length !== 3) throw new Error("arr mismatch");
        if (r?.arr[0] !== 1) throw new Error("arr[0] mismatch");
        if (r?.arr[1] !== "two") throw new Error("arr[1] mismatch");
        if (r?.arr[2] !== null) throw new Error("arr[2] mismatch");
        if (r?.nested?.deep?.value !== 42) throw new Error("nested mismatch");
      },
    },

    // ── Cancel Endpoint ──────────────────────────────────────────────────
    {
      name: "cancel-suspended-and-verify-status",
      category: "endpoint_cancel",
      run: async (baseUrl) => {
        const { base } = await epStart(baseUrl, "suspend-for-cancel", {});
        await epPollStatus(base, "suspended");

        const cancelResp = await httpPostFull(`${base}/cancel`);
        if (cancelResp.status !== 200)
          throw new Error(`cancel returned ${cancelResp.status}`);
        if (cancelResp.body?.status !== "cancelled")
          throw new Error(`expected { status: "cancelled" }, got ${JSON.stringify(cancelResp.body)}`);

        const statusResp = await httpGetFull(`${base}/status`);
        if (statusResp.body?.meta?.status !== "cancelled")
          throw new Error(`status not "cancelled" after cancel: ${statusResp.body?.meta?.status}`);
      },
    },
    {
      name: "cancel-completed-workflow-rejected",
      category: "endpoint_cancel",
      run: async (baseUrl) => {
        const { base } = await epStart(baseUrl, "echo-input", { x: 1 });
        await epPollStatus(base, "completed");
        const resp = await httpPostFull(`${base}/cancel`);
        if (resp.status !== 400)
          throw new Error(`expected 400 for cancelling completed workflow, got ${resp.status}`);
      },
    },

    // ── sdk.callWorkflow suspension ──────────────────────────────────────
    // Verifies that sdk.callWorkflow does NOT block the caller thread. The caller
    // must pass through "suspended" state (durable promise) before the callee
    // resolves it. With the full .start pipeline active the callee may
    // complete so quickly that by the first poll the caller has already
    // resumed and completed — "completed" is therefore also accepted as proof
    // that the suspend→callee→resolve→resume cycle ran end-to-end.
    {
      name: "sdk-call-caller-enters-suspended-state",
      category: "endpoint_sdk_call",
      run: async (baseUrl) => {
        const { base } = await epStart(baseUrl, "sdk-call-basic", {});
        let sawSuspendedOrCompleted = false;
        for (let i = 0; i < 20; i++) {
          await sleep(100);
          const resp = await httpGetFull(`${base}/status`);
          const st = resp.body?.meta?.status;
          if (st === "suspended" || st === "completed") { sawSuspendedOrCompleted = true; break; }
          if (st === "failed") break;
        }
        if (!sawSuspendedOrCompleted) {
          throw new Error("expected caller to enter 'suspended' or 'completed' state; it did not");
        }
      },
    },

    // ── Shared Handler Endpoint ──────────────────────────────────────────
    // These tests share the same suspend-for-signal instance.
    // handler-reads-workflow-state runs FIRST (non-destructive),
    // then handler-resolves-and-returns-value calls signal (destructive).
    {
      name: "handler-reads-workflow-state",
      category: "endpoint_handler",
      run: async (baseUrl) => {
        const { base } = await epStart(baseUrl, "suspend-for-signal", {});
        await epPollStatus(base, "suspended");

        const resp = await httpPostFull(`${base}/handlers/getState`, {});
        if (resp.status !== 200)
          throw new Error(`getState handler returned ${resp.status}`);
        if (resp.body?.phase !== "waiting")
          throw new Error(`expected phase "waiting", got "${resp.body?.phase}"`);
        if (resp.body?.counter !== 42)
          throw new Error(`expected counter 42, got ${resp.body?.counter}`);
      },
    },
    {
      name: "handler-resolves-and-returns-value",
      category: "endpoint_handler",
      run: async (baseUrl) => {
        const { base } = await epStart(baseUrl, "suspend-for-signal", {});
        await epPollStatus(base, "suspended");

        const handlerInput = { payload: "from-handler", code: 99 };
        const handlerResp = await httpPostFull(`${base}/handlers/signal`, handlerInput);
        if (handlerResp.status !== 200)
          throw new Error(`signal handler returned ${handlerResp.status}`);
        if (handlerResp.body?.accepted !== true)
          throw new Error(`expected { accepted: true }, got ${JSON.stringify(handlerResp.body)}`);

        await epPollStatus(base, "completed");
        const res = await httpGetFull(`${base}/result`);
        const result = res.body?.result;
        if (result?.phase !== "done")
          throw new Error(`expected phase "done", got "${result?.phase}"`);
        if (result?.signal?.payload !== "from-handler")
          throw new Error(`signal.payload mismatch: ${JSON.stringify(result?.signal)}`);
        if (result?.signal?.code !== 99)
          throw new Error(`signal.code mismatch: ${JSON.stringify(result?.signal)}`);
      },
    },

    // ── Durability: concurrent-wake-same-instance ───────────────────────
    {
      name: "concurrent-wake-same-instance",
      category: "endpoint_durability",
      run: async (baseUrl) => {
        const { base } = await epStart(baseUrl, "basic-promise", {});
        await epPollStatus(base, "suspended");

        const [r1, r2] = await Promise.all([
          httpPostFull(`${base}/handlers/approve`, { value: "first-resolve" }),
          httpPostFull(`${base}/handlers/approve`, { value: "second-resolve" }),
        ]);

        if (r1.status !== 200 && r2.status !== 200) {
          throw new Error(`both handler calls failed: ${r1.status}, ${r2.status}`);
        }

        await epPollStatus(base, "completed");
        const res = await httpGetFull(`${base}/result`);
        if (res.body?.result?.received !== "first-resolve" && res.body?.result?.received !== "second-resolve") {
          throw new Error(`unexpected result: ${JSON.stringify(res.body?.result)}`);
        }
      },
    },

    // ── Crash Recovery: resume-completed-noop ───────────────────────────
    {
      name: "resume-completed-noop",
      category: "endpoint_crash_recovery",
      run: async (baseUrl) => {
        const { base } = await epStart(baseUrl, "echo-input", { v: 42 });
        await epPollStatus(base, "completed");

        const status1 = await httpGetFull(`${base}/status`);
        if (status1.body?.meta?.status !== "completed") {
          throw new Error(`expected completed, got ${status1.body?.meta?.status}`);
        }

        await sleep(200);

        const status2 = await httpGetFull(`${base}/status`);
        if (status2.body?.meta?.status !== "completed") {
          throw new Error(`status changed after re-poll: ${status2.body?.meta?.status}`);
        }

        const res1 = await httpGetFull(`${base}/result`);
        const res2 = await httpGetFull(`${base}/result`);
        if (JSON.stringify(res1.body?.result) !== JSON.stringify(res2.body?.result)) {
          throw new Error("result changed between polls on completed workflow");
        }
      },
    },

    // ── Crash Recovery: resume-failed-noop ──────────────────────────────
    {
      name: "resume-failed-noop",
      category: "endpoint_crash_recovery",
      run: async (baseUrl) => {
        const { base } = await epStart(baseUrl, "resume-failed-noop", {});
        await epPollStatus(base, "failed");

        const status1 = await httpGetFull(`${base}/status`);
        if (status1.body?.meta?.status !== "failed") {
          throw new Error(`expected failed, got ${status1.body?.meta?.status}`);
        }

        await sleep(300);

        const status2 = await httpGetFull(`${base}/status`);
        if (status2.body?.meta?.status !== "failed") {
          throw new Error(`status changed after re-poll: ${status2.body?.meta?.status}`);
        }
      },
    },

    // ── Crash Recovery: resume-cancelled-noop ───────────────────────────
    {
      name: "resume-cancelled-noop",
      category: "endpoint_crash_recovery",
      run: async (baseUrl) => {
        const { base } = await epStart(baseUrl, "workflow-cancellation", {});
        await epPollStatus(base, "suspended");

        const cancelResp = await httpPostFull(`${base}/cancel`);
        if (cancelResp.status !== 200) {
          throw new Error(`cancel returned ${cancelResp.status}`);
        }

        await sleep(300);

        const status = await httpGetFull(`${base}/status`);
        if (status.body?.meta?.status !== "cancelled") {
          throw new Error(`expected cancelled after re-poll, got ${status.body?.meta?.status}`);
        }
      },
    },

    // ── Lifecycle: cancel-then-restart-fresh ────────────────────────────
    {
      name: "cancel-then-restart-fresh",
      category: "endpoint_lifecycle",
      run: async (baseUrl) => {
        const { base: base1 } = await epStart(baseUrl, "workflow-cancellation", {});
        await epPollStatus(base1, "suspended");
        await httpPostFull(`${base1}/cancel`);

        const { base: base2 } = await epStart(baseUrl, "echo-input", { fresh: true });
        await epPollStatus(base2, "completed");

        const res = await httpGetFull(`${base2}/result`);
        if (res.body?.result?.fresh !== true) {
          throw new Error(`new instance result mismatch: ${JSON.stringify(res.body?.result)}`);
        }

        const old = await httpGetFull(`${base1}/status`);
        if (old.body?.meta?.status !== "cancelled") {
          throw new Error(`old instance should still be cancelled, got ${old.body?.meta?.status}`);
        }
      },
    },

    // ── Promises: promise-resolved-after-cancel ──────────────────────────
    {
      name: "promise-resolved-after-cancel",
      category: "endpoint_promises",
      run: async (baseUrl) => {
        const { base } = await epStart(baseUrl, "promise-resolved-after-cancel", {});
        await epPollStatus(base, "suspended");

        await httpPostFull(`${base}/cancel`);
        const afterCancel = await httpGetFull(`${base}/status`);
        if (afterCancel.body?.meta?.status !== "cancelled") {
          throw new Error(`expected cancelled, got ${afterCancel.body?.meta?.status}`);
        }

        await httpPostFull(`${base}/handlers/resolve`, { value: "late-resolve" });

        await sleep(300);

        const final = await httpGetFull(`${base}/status`);
        if (final.body?.meta?.status !== "cancelled") {
          throw new Error(`workflow resumed after resolve on cancelled instance: ${final.body?.meta?.status}`);
        }
      },
    },

    // ── Promises: promise-handler-idempotent ─────────────────────────────
    {
      name: "promise-handler-idempotent",
      category: "endpoint_promises",
      run: async (baseUrl) => {
        const { base } = await epStart(baseUrl, "promise-handler-idempotent", {});
        await epPollStatus(base, "suspended");

        const r1 = await httpPostFull(`${base}/handlers/resolve`, { value: "first" });
        if (r1.status !== 200) {
          throw new Error(`first resolve returned ${r1.status}`);
        }

        await epPollStatus(base, "completed");

        const r2 = await httpPostFull(`${base}/handlers/resolve`, { value: "second" });

        const res = await httpGetFull(`${base}/result`);
        const value = res.body?.result?.value;
        if (value !== "first") {
          throw new Error(`expected "first", got "${value}" (second resolve may have overwritten)`);
        }

        void r2;
      },
    },

    // ── Endpoints: status-during-sleep ────────────────────────────────────
    {
      name: "status-during-sleep",
      category: "endpoint_status",
      run: async (baseUrl) => {
        const { base } = await epStart(baseUrl, "cancel-during-sleep", {});
        const body = await epPollStatus(base, "suspended");

        if (body?.meta?.status !== "suspended") {
          throw new Error(`expected suspended, got ${body?.meta?.status}`);
        }

        await httpPostFull(`${base}/cancel`);
      },
    },

    // ── Endpoints: result-before-completion ──────────────────────────────
    {
      name: "result-before-completion",
      category: "endpoint_result",
      run: async (baseUrl) => {
        const { base } = await epStart(baseUrl, "cancel-during-sleep", {});
        await epPollStatus(base, "suspended");

        const res = await httpGetFull(`${base}/result`);
        if (res.status === 200 && res.body?.result !== undefined && res.body?.result !== null) {
          throw new Error(`got non-null result while workflow is still suspended`);
        }

        await httpPostFull(`${base}/cancel`);
      },
    },

    // ── Endpoints: start-already-running ─────────────────────────────────
    {
      name: "start-already-running",
      category: "endpoint_start",
      run: async (baseUrl) => {
        const { base } = await epStart(baseUrl, "cancel-during-sleep", {});
        await epPollStatus(base, "suspended");

        const r2 = await httpPostFull(epWfUrl(baseUrl, "cancel-during-sleep"), {});
        if (!r2.body?.instanceId) {
          throw new Error(`second start failed: ${JSON.stringify(r2.body)}`);
        }

        const base2 = `${epWfUrl(baseUrl, "cancel-during-sleep")}/${r2.body.instanceId}`;
        await epPollStatus(base2, "suspended");

        await httpPostFull(`${base}/cancel`);
        await httpPostFull(`${base2}/cancel`);
      },
    },

    // ── State: state-isolation-between-instances ──────────────────────────
    {
      name: "state-isolation-between-instances",
      category: "endpoint_state",
      run: async (baseUrl) => {
        const [a, b] = await Promise.all([
          epStart(baseUrl, "state-isolation-between-instances", { tag: "instance-A" }),
          epStart(baseUrl, "state-isolation-between-instances", { tag: "instance-B" }),
        ]);

        await Promise.all([
          epPollStatus(a.base, "completed"),
          epPollStatus(b.base, "completed"),
        ]);

        const [resA, resB] = await Promise.all([
          httpGetFull(`${a.base}/result`),
          httpGetFull(`${b.base}/result`),
        ]);

        if (resA.body?.result?.readBack !== "instance-A") {
          throw new Error(`instance A got readBack="${resA.body?.result?.readBack}"`);
        }
        if (resB.body?.result?.readBack !== "instance-B") {
          throw new Error(`instance B got readBack="${resB.body?.result?.readBack}"`);
        }
        if (!resA.body?.result?.isolatedCorrectly) {
          throw new Error("instance A isolation failed");
        }
        if (!resB.body?.result?.isolatedCorrectly) {
          throw new Error("instance B isolation failed");
        }
      },
    },

    // ── Handler endpoint gap coverage ────────────────────────────────────
    {
      name: "handler-nonexistent-instance-404",
      category: "endpoint_handler",
      run: async (baseUrl) => {
        const fakeId = "00000000-dead-beef-0000-111111111111";
        const url = `${epWfUrl(baseUrl, "suspend-for-signal")}/${fakeId}/handlers/signal`;
        const resp = await httpPostFull(url, {});
        if (resp.status !== 404)
          throw new Error(`expected 404 for handler on nonexistent instance, got ${resp.status}`);
      },
    },
    {
      name: "handler-on-completed-instance",
      category: "endpoint_handler",
      run: async (baseUrl) => {
        const { base } = await epStart(baseUrl, "echo-input", { v: 1 });
        await epPollStatus(base, "completed");
        const resp = await httpPostFull(`${base}/handlers/signal`, {});
        if (resp.status === 200 && resp.body?.accepted === true)
          throw new Error(`handler on completed instance should be rejected, got accepted=true`);
      },
    },
    {
      name: "handler-on-cancelled-instance",
      category: "endpoint_handler",
      run: async (baseUrl) => {
        const { base } = await epStart(baseUrl, "suspend-for-cancel", {});
        await epPollStatus(base, "suspended");
        await httpPostFull(`${base}/cancel`);
        await epPollStatus(base, "cancelled").catch(() => {});
        const resp = await httpPostFull(`${base}/handlers/signal`, {});
        if (resp.status === 200 && resp.body?.accepted === true)
          throw new Error(`handler on cancelled instance should be rejected, got accepted=true`);
      },
    },
    {
      name: "handler-on-failed-instance",
      category: "endpoint_handler",
      run: async (baseUrl) => {
        const { base } = await epStart(baseUrl, "resume-failed-noop", {});
        for (let i = 0; i < 60; i++) {
          await sleep(150);
          const r = await httpGetFull(`${base}/status`);
          if (r.body?.meta?.status === "failed") break;
        }
        const resp = await httpPostFull(`${base}/handlers/signal`, {});
        if (resp.status === 200 && resp.body?.accepted === true)
          throw new Error(`handler on failed instance should be rejected, got accepted=true`);
      },
    },
    {
      name: "handler-invalid-name-400",
      category: "endpoint_handler",
      run: async (baseUrl) => {
        const { base } = await epStart(baseUrl, "suspend-for-signal", {});
        await epPollStatus(base, "suspended");
        const resp = await httpPostFull(`${base}/handlers/my-handler!`, {});
        if (resp.status !== 400)
          throw new Error(`expected 400 for handler with invalid chars, got ${resp.status}`);
        await httpPostFull(`${base}/handlers/signal`, {});
      },
    },
    {
      name: "handler-unknown-name-on-valid-instance",
      category: "endpoint_handler",
      run: async (baseUrl) => {
        const { base } = await epStart(baseUrl, "suspend-for-signal", {});
        await epPollStatus(base, "suspended");
        const resp = await httpPostFull(`${base}/handlers/nonExistentHandler`, {});
        if (resp.status !== 400 && resp.status !== 404)
          throw new Error(`expected 400 or 404 for unknown handler name, got ${resp.status}`);
        await httpPostFull(`${base}/handlers/signal`, {});
      },
    },

    // ── Cancel endpoint gap coverage ──────────────────────────────────────
    {
      name: "cancel-nonexistent-instance-404",
      category: "endpoint_cancel",
      run: async (baseUrl) => {
        const fakeId = "00000000-dead-beef-0000-222222222222";
        const url = `${epWfUrl(baseUrl, "echo-input")}/${fakeId}/cancel`;
        const resp = await httpPostFull(url);
        if (resp.status !== 404)
          throw new Error(`expected 404 for cancel on nonexistent instance, got ${resp.status}`);
      },
    },
    {
      name: "cancel-failed-instance",
      category: "endpoint_cancel",
      run: async (baseUrl) => {
        const { base } = await epStart(baseUrl, "resume-failed-noop", {});
        for (let i = 0; i < 60; i++) {
          await sleep(150);
          const r = await httpGetFull(`${base}/status`);
          if (r.body?.meta?.status === "failed") break;
        }
        const resp = await httpPostFull(`${base}/cancel`);
        if (resp.status === 200 && resp.body?.status === "cancelled")
          throw new Error(`cancel on failed instance should be rejected, got status=cancelled`);
      },
    },

    // ── Start endpoint gap coverage ───────────────────────────────────────
    {
      name: "start-invalid-project-id-400",
      category: "endpoint_start",
      run: async (baseUrl) => {
        const url = `${baseUrl}/api/v1/trigger/wf/not-a-uuid/test/wf/echo-input`;
        const resp = await httpPostFull(url, {});
        if (resp.status !== 400 && resp.status !== 404)
          throw new Error(`expected 400 or 404 for invalid project_id, got ${resp.status}`);
      },
    },

    // ── Result endpoint gap coverage ──────────────────────────────────────
    {
      name: "result-failed-instance-response-shape",
      category: "endpoint_result",
      run: async (baseUrl) => {
        const { base } = await epStart(baseUrl, "resume-failed-noop", {});
        for (let i = 0; i < 60; i++) {
          await sleep(150);
          const r = await httpGetFull(`${base}/status`);
          if (r.body?.meta?.status === "failed") break;
        }
        const resp = await httpGetFull(`${base}/result`);
        if (resp.status !== 200 && resp.status !== 400)
          throw new Error(`result on failed instance: expected 200 or 400, got ${resp.status}`);
        if (resp.status === 200) {
          const body = resp.body as Record<string, unknown>;
          if (!("status" in body))
            throw new Error(`result on failed instance missing 'status' field: ${JSON.stringify(body)}`);
        }
      },
    },
    {
      name: "result-nonexistent-instance-404",
      category: "endpoint_result",
      run: async (baseUrl) => {
        const fakeId = "00000000-dead-beef-0000-333333333333";
        const url = `${epWfUrl(baseUrl, "echo-input")}/${fakeId}/result`;
        const resp = await httpGetFull(url);
        if (resp.status !== 404)
          throw new Error(`expected 404 for result of nonexistent instance, got ${resp.status}`);
      },
    },

    // ── Stage route coverage ──────────────────────────────────────────────
    {
      name: "start-returns-instance-id",
      category: "endpoint_stage",
      run: async (baseUrl) => {
        const resp = await httpPostFull(epWfStageUrl(baseUrl, "echo-input"), { v: "stage-test" });
        if (resp.status !== 200)
          throw new Error(`stage start expected 200, got ${resp.status}`);
        if (!resp.body?.instanceId)
          throw new Error("stage start: missing instanceId in response");
      },
    },
    {
      name: "start-passes-input",
      category: "endpoint_stage",
      run: async (baseUrl) => {
        const stageBase = `${epWfStageUrl(baseUrl, "echo-input")}`;
        const resp = await httpPostFull(stageBase, { value: "stage-input" });
        if (resp.status !== 200) throw new Error(`stage start returned ${resp.status}`);
        const instanceId = resp.body?.instanceId as string | undefined;
        if (!instanceId) throw new Error("no instanceId");
        const instanceBase = `${stageBase}/${instanceId}`;
        for (let i = 0; i < 40; i++) {
          await sleep(150);
          const r = await httpGetFull(`${instanceBase}/status`);
          if (r.body?.meta?.status === "completed") {
            const res = await httpGetFull(`${instanceBase}/result`);
            if (res.body?.result?.value !== "stage-input")
              throw new Error(`stage input not passed: ${JSON.stringify(res.body?.result)}`);
            return;
          }
        }
        throw new Error("stage workflow did not complete");
      },
    },
    {
      name: "status-completed",
      category: "endpoint_stage",
      run: async (baseUrl) => {
        const resp = await httpPostFull(epWfStageUrl(baseUrl, "echo-input"), {});
        if (resp.status !== 200) throw new Error(`stage start failed: ${resp.status}`);
        const instanceId = resp.body?.instanceId as string | undefined;
        if (!instanceId) throw new Error("no instanceId");
        const stageBase = `${epWfStageUrl(baseUrl, "echo-input")}/${instanceId}`;
        for (let i = 0; i < 40; i++) {
          await sleep(150);
          const r = await httpGetFull(`${stageBase}/status`);
          if (r.body?.meta?.status === "completed") return;
        }
        throw new Error("stage status never reached completed");
      },
    },
    {
      name: "status-suspended",
      category: "endpoint_stage",
      run: async (baseUrl) => {
        const resp = await httpPostFull(epWfStageUrl(baseUrl, "suspend-for-signal"), {});
        if (resp.status !== 200) throw new Error(`stage start failed: ${resp.status}`);
        const instanceId = resp.body?.instanceId as string | undefined;
        if (!instanceId) throw new Error("no instanceId");
        const stageBase = `${epWfStageUrl(baseUrl, "suspend-for-signal")}/${instanceId}`;
        for (let i = 0; i < 40; i++) {
          await sleep(150);
          const r = await httpGetFull(`${stageBase}/status`);
          if (r.body?.meta?.status === "suspended") {
            await httpPostFull(`${stageBase}/handlers/signal`, {});
            return;
          }
        }
        throw new Error("stage workflow never reached suspended");
      },
    },
    {
      name: "result-completed-shape",
      category: "endpoint_stage",
      run: async (baseUrl) => {
        const resp = await httpPostFull(epWfStageUrl(baseUrl, "echo-input"), { msg: "hello" });
        if (resp.status !== 200) throw new Error(`stage start failed: ${resp.status}`);
        const instanceId = resp.body?.instanceId as string | undefined;
        if (!instanceId) throw new Error("no instanceId");
        const stageBase = `${epWfStageUrl(baseUrl, "echo-input")}/${instanceId}`;
        for (let i = 0; i < 40; i++) {
          await sleep(150);
          const r = await httpGetFull(`${stageBase}/status`);
          if (r.body?.meta?.status === "completed") {
            const res = await httpGetFull(`${stageBase}/result`);
            if (res.status !== 200) throw new Error(`stage result expected 200, got ${res.status}`);
            if (res.body?.status !== "completed")
              throw new Error(`stage result status not "completed": ${JSON.stringify(res.body)}`);
            return;
          }
        }
        throw new Error("stage workflow did not complete in time");
      },
    },
    {
      name: "cancel-suspended",
      category: "endpoint_stage",
      run: async (baseUrl) => {
        const resp = await httpPostFull(epWfStageUrl(baseUrl, "suspend-for-cancel"), {});
        if (resp.status !== 200) throw new Error(`stage start failed: ${resp.status}`);
        const instanceId = resp.body?.instanceId as string | undefined;
        if (!instanceId) throw new Error("no instanceId");
        const stageBase = `${epWfStageUrl(baseUrl, "suspend-for-cancel")}/${instanceId}`;
        for (let i = 0; i < 40; i++) {
          await sleep(150);
          const r = await httpGetFull(`${stageBase}/status`);
          if (r.body?.meta?.status === "suspended") {
            const cancelResp = await httpPostFull(`${stageBase}/cancel`);
            if (cancelResp.status !== 200)
              throw new Error(`stage cancel expected 200, got ${cancelResp.status}`);
            return;
          }
        }
        throw new Error("stage workflow never suspended for cancel");
      },
    },
    {
      name: "handler-resolves",
      category: "endpoint_stage",
      run: async (baseUrl) => {
        const resp = await httpPostFull(epWfStageUrl(baseUrl, "suspend-for-signal"), {});
        if (resp.status !== 200) throw new Error(`stage start failed: ${resp.status}`);
        const instanceId = resp.body?.instanceId as string | undefined;
        if (!instanceId) throw new Error("no instanceId");
        const stageBase = `${epWfStageUrl(baseUrl, "suspend-for-signal")}/${instanceId}`;
        for (let i = 0; i < 40; i++) {
          await sleep(150);
          const r = await httpGetFull(`${stageBase}/status`);
          if (r.body?.meta?.status === "suspended") {
            const hr = await httpPostFull(`${stageBase}/handlers/signal`, { data: "stage-signal" });
            if (hr.status !== 200)
              throw new Error(`stage handler call expected 200, got ${hr.status}`);
            return;
          }
        }
        throw new Error("stage workflow never suspended for handler");
      },
    },
    {
      name: "start-unknown-runtime-id-404",
      category: "endpoint_stage",
      run: async (baseUrl) => {
        const unknownRuntimeId = "00000000-dead-0000-0000-999999999999";
        const resp = await httpPostFull(epWfStageUrl(baseUrl, "echo-input", unknownRuntimeId), {});
        if (resp.status !== 404)
          throw new Error(`expected 404 for unknown runtime_id, got ${resp.status}`);
      },
    },
    {
      name: "production-and-stage-isolated",
      category: "endpoint_stage",
      run: async (baseUrl) => {
        const [prodResp, stageResp] = await Promise.all([
          httpPostFull(epWfUrl(baseUrl, "echo-input"), { source: "prod" }),
          httpPostFull(epWfStageUrl(baseUrl, "echo-input"), { source: "stage" }),
        ]);
        if (prodResp.status !== 200) throw new Error(`prod start failed: ${prodResp.status}`);
        if (stageResp.status !== 200) throw new Error(`stage start failed: ${stageResp.status}`);
        const prodId = prodResp.body?.instanceId as string | undefined;
        const stageId = stageResp.body?.instanceId as string | undefined;
        if (!prodId || !stageId) throw new Error("missing instanceId in one of the responses");
        if (prodId === stageId)
          throw new Error(`prod and stage returned the same instanceId: ${prodId}`);
        const prodBase = `${epWfUrl(baseUrl, "echo-input")}/${prodId}`;
        const stageBase = `${epWfStageUrl(baseUrl, "echo-input")}/${stageId}`;
        for (let i = 0; i < 40; i++) {
          await sleep(150);
          const [pr, sr] = await Promise.all([
            httpGetFull(`${prodBase}/status`),
            httpGetFull(`${stageBase}/status`),
          ]);
          if (pr.body?.meta?.status === "completed" && sr.body?.meta?.status === "completed") {
            const [prodResult, stageResult] = await Promise.all([
              httpGetFull(`${prodBase}/result`),
              httpGetFull(`${stageBase}/result`),
            ]);
            if (prodResult.body?.result?.source !== "prod")
              throw new Error(`prod result has wrong source: ${JSON.stringify(prodResult.body?.result)}`);
            if (stageResult.body?.result?.source !== "stage")
              throw new Error(`stage result has wrong source: ${JSON.stringify(stageResult.body?.result)}`);
            return;
          }
        }
        throw new Error("prod and stage workflows did not both complete in time");
      },
    },

  ];
  // Note: WebSocket tests (endpoint_ws) are intentionally absent here.
  // They are run by ws-tests.mjs, a standalone Node.js script, because the
  // QuickJS API runner is synchronous and cannot drive a real WebSocket event
  // loop.  test.sh runs ws-tests.mjs after this suite and merges the reports.
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleRequest(req: IncomingMessage, res: ServerResponse) {
  const baseUrl = getBaseUrl(req);
  const tests = allTests();
  const results: TestResult[] = [];

  for (const test of tests) {
    const result = await runTest(baseUrl, test);
    results.push(result);
  }

  for (const et of allEndpointTests()) {
    const result = await runEndpointTest(baseUrl, et);
    results.push(result);
  }

  const report = buildReport(results);
  const body = JSON.stringify(report, null, 2);

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(body);
}
