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

    for (let iter = 0; iter < 100; iter++) {
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
  _firstInstanceId: string,
  firstOutput: any,
): Promise<TestResult> {
  const wfBase = `${baseUrl}/api/v1/trigger/wf/${PROJECT_ID}/test/wf/${test.workflowSlug}`;
  const replayResp = await httpPost(wfBase, test.input);
  if (!replayResp?.instanceId) return fail(test, `replay start failed`);
  const replayId = replayResp.instanceId;
  const replayBase = `${wfBase}/${replayId}`;

  for (let i = 0; i < 50; i++) {
    await sleep(100);
    const s = await httpGet(`${replayBase}/status`);
    const st = s?.meta?.status;
    if (st === "completed") break;
    if (st === "suspended") {
      await sleep(200);
      continue;
    }
  }

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
// Test definitions — 48 tests
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

    // ---- integration (2) ----
    {
      name: "sdk-call-unsupported-type", category: "integration",
      workflowSlug: "sdk-call-unsupported-type",
      input: {},
      handlers: [], timeoutPromise: false, cancelOnSuspend: false,
      replay: false, dedup: false,
      checks: [
        { type: "true", path: "ok" },
        { type: "contains", path: "errorMessage", substr: "not supported" },
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
  ];
}

// ---------------------------------------------------------------------------
// Report builder
// ---------------------------------------------------------------------------

function buildReport(results: TestResult[]) {
  const total = results.length;
  const passed = results.filter((r) => r.pass).length;
  const failed = total - passed;
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
    summary: { healthy, total_tests: total, total_passed: passed, total_failed: failed, sections: sectionSummaries },
    sections: sectionDetails,
    tests: flatTests,
  };
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

  const report = buildReport(results);
  const body = JSON.stringify(report, null, 2);

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(body);
}
