/**
 * API Integration Test Runner (API unit)
 *
 * An API unit that exercises all API unit tests end-to-end via HTTP.
 * When triggered, it calls each API unit under test, validates the response,
 * and returns a structured JSON report.
 *
 * GET / — runs all tests and returns a JSON report.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PROJECT_ID = "00000000-aaaa-bbbb-cccc-000000000010";
const STAGE_RUNTIME_ID = "00000000-aaaa-bbbb-cccc-000000000022";
const STAGE_B_RUNTIME_ID = "00000000-aaaa-bbbb-cccc-000000000023";
const WRONG_PROJECT_ID = "00000000-dead-beef-0000-000000000099";
const NONEXISTENT_RUNTIME_ID = "00000000-ffff-ffff-0000-000000000099";

function getBaseUrl(req: IncomingMessage): string {
  const host = req.headers.host ?? "127.0.0.1:3336";
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

interface ApiTestDef {
  name: string;
  category: string;
  /** When set, the test is recorded as skipped (pending an unimplemented feature). */
  skip?: string;
  run: (baseUrl: string) => Promise<void>;
}

export type RequestBody = never;
export type ResponseBody = {
  summary: {
    healthy: boolean;
    total_tests: number;
    total_passed: number;
    total_failed: number;
    total_skipped: number;
    sections: Record<string, unknown>;
  };
  sections: Record<string, unknown>;
  tests: Array<{ name: string; pass: boolean }>;
};
export type QueryParams = never;

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function httpPost(url: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : "{}",
  });
  const responseText = await resp.text();
  let parsed: unknown;
  try { parsed = JSON.parse(responseText); } catch { parsed = responseText; }
  return { status: resp.status, body: parsed };
}

async function httpGet(url: string, headers?: Record<string, string>): Promise<{ status: number; body: unknown }> {
  const resp = await fetch(url, headers !== undefined ? { headers } : undefined);
  const responseText = await resp.text();
  let parsed: unknown;
  try { parsed = JSON.parse(responseText); } catch { parsed = responseText; }
  return { status: resp.status, body: parsed };
}

async function httpSend(
  method: string,
  url: string,
  init?: { headers?: Record<string, string>; body?: string },
): Promise<{ status: number; body: unknown; text: string; headers: Headers }> {
  const reqInit: RequestInit = { method };
  if (init?.headers !== undefined) reqInit.headers = init.headers;
  if (init?.body !== undefined) reqInit.body = init.body;
  const resp = await fetch(url, reqInit);
  const responseText = await resp.text();
  let parsed: unknown;
  try { parsed = JSON.parse(responseText); } catch { parsed = responseText; }
  return { status: resp.status, body: parsed, text: responseText, headers: resp.headers };
}

const PLATFORM_DEFAULT_TIMEOUT_TEST_GRACE_MS = 35_000;

/** Hanging unit must be cut off by ~30 s default; allow `graceMs` (prod e2e). */
async function expectHangReleasedWithinGrace(url: string, what: string): Promise<void> {
  let released = false;
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    void fetch(url)
      .then(() => {
        released = true;
        if (timer !== undefined) clearTimeout(timer);
        resolve();
      })
      .catch(() => {
        released = true;
        if (timer !== undefined) clearTimeout(timer);
        resolve();
      });
    timer = setTimeout(() => {
      if (!released) {
        reject(new Error(
          `${what}: connection still open after ${PLATFORM_DEFAULT_TIMEOUT_TEST_GRACE_MS} ms`,
        ));
      }
    }, PLATFORM_DEFAULT_TIMEOUT_TEST_GRACE_MS);
  });
}

// ---------------------------------------------------------------------------
// API unit URL helpers
// ---------------------------------------------------------------------------

/** Trigger URL for an API unit in the api-tests module (production runtime). */
function apiUrl(baseUrl: string, slug: string): string {
  return `${baseUrl}/api/v1/trigger/${PROJECT_ID}/test/api-tests/${slug}`;
}

/** Trigger URL for an API unit in the api-tests module (stage runtime). */
function apiStageUrl(baseUrl: string, slug: string, runtimeId = STAGE_RUNTIME_ID): string {
  return `${baseUrl}/api/v1/trigger/${PROJECT_ID}/stage/${runtimeId}/test/api-tests/${slug}`;
}

/** Trigger URL using a different (potentially wrong) project. */
function apiWrongProjectUrl(baseUrl: string, slug: string): string {
  return `${baseUrl}/api/v1/trigger/${WRONG_PROJECT_ID}/test/api-tests/${slug}`;
}

// ---------------------------------------------------------------------------
// Unique id per invocation — prevents actor state collisions between runs
// ---------------------------------------------------------------------------

function testRunTag(): string {
  return Date.now().toString(36);
}

// ---------------------------------------------------------------------------
// Test definitions
// ---------------------------------------------------------------------------

function allTests(): ApiTestDef[] {
  const runTag = testRunTag();

  return [

    // ── basic: echo ──────────────────────────────────────────────────────────
    {
      name: "echo-returns-body",
      category: "basic",
      run: async (baseUrl) => {
        const input = { hello: "world", n: 42 };
        const resp = await httpPost(apiUrl(baseUrl, "echo"), input);
        if (resp.status !== 200)
          throw new Error(`expected 200, got ${resp.status}`);
        const body = resp.body as Record<string, unknown>;
        const echoed = body["echoed"] as Record<string, unknown> | undefined;
        if (echoed?.["hello"] !== "world")
          throw new Error(`echoed.hello mismatch: ${JSON.stringify(echoed)}`);
        if (echoed?.["n"] !== 42)
          throw new Error(`echoed.n mismatch: ${JSON.stringify(echoed)}`);
      },
    },
    {
      name: "echo-returns-method",
      category: "basic",
      run: async (baseUrl) => {
        const resp = await httpPost(apiUrl(baseUrl, "echo"), { test: true });
        if (resp.status !== 200)
          throw new Error(`expected 200, got ${resp.status}`);
        const body = resp.body as Record<string, unknown>;
        if (body["method"] !== "POST")
          throw new Error(`expected method "POST", got "${String(body["method"])}"`);
      },
    },
    {
      name: "echo-empty-body",
      category: "basic",
      run: async (baseUrl) => {
        const resp = await httpPost(apiUrl(baseUrl, "echo"));
        if (resp.status !== 200)
          throw new Error(`expected 200 with empty body, got ${resp.status}`);
      },
    },
    {
      name: "echo-preserves-complex-types",
      category: "basic",
      run: async (baseUrl) => {
        const input = {
          str: "hello",
          num: -3.14,
          bool: true,
          nil: null,
          arr: [1, "two", null],
          nested: { deep: { value: 42 } },
        };
        const resp = await httpPost(apiUrl(baseUrl, "echo"), input);
        if (resp.status !== 200)
          throw new Error(`expected 200, got ${resp.status}`);
        const echoed = (resp.body as Record<string, unknown>)["echoed"] as Record<string, unknown>;
        if (echoed["str"] !== "hello") throw new Error("str mismatch");
        if (echoed["num"] !== -3.14) throw new Error("num mismatch");
        if (echoed["bool"] !== true) throw new Error("bool mismatch");
        if (echoed["nil"] !== null) throw new Error("nil mismatch");
        const arr = echoed["arr"] as unknown[];
        if (!Array.isArray(arr) || arr.length !== 3) throw new Error("arr mismatch");
        if (arr[0] !== 1) throw new Error("arr[0] mismatch");
        if (arr[1] !== "two") throw new Error("arr[1] mismatch");
        if (arr[2] !== null) throw new Error("arr[2] mismatch");
        const nested = echoed["nested"] as Record<string, Record<string, unknown>>;
        if (nested["deep"]?.["value"] !== 42) throw new Error("nested mismatch");
      },
    },

    // ── basic: HTTP contract ─────────────────────────────────────────────────
    {
      name: "get-method-unit-returns-get",
      category: "basic",
      run: async (baseUrl) => {
        const resp = await httpGet(apiUrl(baseUrl, "get-method"));
        if (resp.status !== 200)
          throw new Error(`expected 200, got ${resp.status}`);
        const method = (resp.body as Record<string, unknown>)["method"];
        if (method !== "GET")
          throw new Error(`expected method "GET", got "${String(method)}"`);
      },
    },
    {
      name: "headers-unit-echoes-custom-header",
      category: "basic",
      run: async (baseUrl) => {
        const resp = await httpGet(apiUrl(baseUrl, "headers"), {
          "x-test-header": "hello-from-test",
          "x-custom-value": "42",
        });
        if (resp.status !== 200)
          throw new Error(`expected 200, got ${resp.status}`);
        const received = (resp.body as Record<string, unknown>)["received"] as Record<string, unknown> | undefined;
        if (received?.["x-test-header"] !== "hello-from-test")
          throw new Error(`x-test-header mismatch: ${JSON.stringify(received)}`);
        if (received?.["x-custom-value"] !== "42")
          throw new Error(`x-custom-value mismatch: ${JSON.stringify(received)}`);
      },
    },
    {
      name: "query-params-unit-echoes-params",
      category: "basic",
      run: async (baseUrl) => {
        const url = `${apiUrl(baseUrl, "query-params")}?foo=bar&baz=123&multi=a`;
        const resp = await httpGet(url);
        if (resp.status !== 200)
          throw new Error(`expected 200, got ${resp.status}`);
        const params = (resp.body as Record<string, unknown>)["params"] as Record<string, unknown> | undefined;
        if (params?.["foo"] !== "bar")
          throw new Error(`foo mismatch: ${JSON.stringify(params)}`);
        if (params?.["baz"] !== "123")
          throw new Error(`baz mismatch: ${JSON.stringify(params)}`);
      },
    },
    {
      name: "query-params-empty-when-none-sent",
      category: "basic",
      run: async (baseUrl) => {
        const resp = await httpGet(apiUrl(baseUrl, "query-params"));
        if (resp.status !== 200)
          throw new Error(`expected 200, got ${resp.status}`);
        const params = (resp.body as Record<string, unknown>)["params"] as Record<string, unknown> | undefined;
        if (typeof params !== "object" || params === null)
          throw new Error(`expected object, got ${JSON.stringify(params)}`);
        if (Object.keys(params).length !== 0)
          throw new Error(`expected empty params, got ${JSON.stringify(params)}`);
      },
    },

    // ── methods: HTTP verbs, non-JSON body, attachment-style GET ─────────────
    {
      name: "post-method-unit-returns-post",
      category: "methods",
      run: async (baseUrl) => {
        const resp = await httpSend("POST", apiUrl(baseUrl, "post-method"));
        if (resp.status !== 200)
          throw new Error(`expected 200, got ${resp.status}`);
        if ((resp.body as Record<string, unknown>)["method"] !== "POST")
          throw new Error(`expected POST, got ${JSON.stringify(resp.body)}`);
      },
    },
    {
      name: "put-to-echo-returns-put",
      category: "methods",
      run: async (baseUrl) => {
        const resp = await httpSend("PUT", apiUrl(baseUrl, "echo"), {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ verb: "put" }),
        });
        if (resp.status !== 200)
          throw new Error(`expected 200, got ${resp.status}`);
        if ((resp.body as Record<string, unknown>)["method"] !== "PUT")
          throw new Error(`expected PUT, got ${JSON.stringify(resp.body)}`);
        const echoed = (resp.body as Record<string, unknown>)["echoed"] as Record<string, unknown> | undefined;
        if (echoed?.["verb"] !== "put")
          throw new Error(`echo body wrong: ${JSON.stringify(echoed)}`);
      },
    },
    {
      name: "patch-to-echo-returns-patch",
      category: "methods",
      run: async (baseUrl) => {
        const resp = await httpSend("PATCH", apiUrl(baseUrl, "echo"), {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ n: 2 }),
        });
        if (resp.status !== 200)
          throw new Error(`expected 200, got ${resp.status}`);
        if ((resp.body as Record<string, unknown>)["method"] !== "PATCH")
          throw new Error(`expected PATCH, got ${JSON.stringify(resp.body)}`);
      },
    },
    {
      name: "delete-to-echo-returns-delete",
      category: "methods",
      run: async (baseUrl) => {
        const resp = await httpSend("DELETE", apiUrl(baseUrl, "echo"), {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mark: "del" }),
        });
        if (resp.status !== 200)
          throw new Error(`expected 200, got ${resp.status}`);
        if ((resp.body as Record<string, unknown>)["method"] !== "DELETE")
          throw new Error(`expected DELETE, got ${JSON.stringify(resp.body)}`);
      },
    },
    {
      name: "text-plain-upload-roundtrips-utf8",
      category: "methods",
      run: async (baseUrl) => {
        const upload = "plain\nlines\n世界";
        const resp = await httpSend("POST", apiUrl(baseUrl, "text-body-echo"), {
          headers: { "Content-Type": "text/plain; charset=utf-8" },
          body: upload,
        });
        if (resp.status !== 200)
          throw new Error(`expected 200, got ${resp.status}`);
        const b = resp.body as Record<string, unknown>;
        if (b["body"] !== upload)
          throw new Error(`body mismatch: ${JSON.stringify(b["body"])}`);
        if (typeof b["contentType"] !== "string" || !b["contentType"].includes("text/plain"))
          throw new Error(`content-type not echoed: ${String(b["contentType"])}`);
        if (b["length"] !== upload.length)
          throw new Error(`length field wrong: ${String(b["length"])} vs ${upload.length}`);
      },
    },
    {
      name: "attachment-download-disposition-and-text-payload",
      category: "methods",
      run: async (baseUrl) => {
        const resp = await fetch(apiUrl(baseUrl, "attachment-download"));
        if (resp.status !== 200)
          throw new Error(`expected 200, got ${resp.status}`);
        const cd = resp.headers.get("content-disposition") ?? "";
        if (!cd.toLowerCase().includes("attachment"))
          throw new Error(`expected attachment Content-Disposition, got "${cd}"`);
        const payload = await resp.text();
        if (!payload.includes("alpha") || !payload.includes("gamma"))
          throw new Error(`unexpected payload: ${JSON.stringify(payload)}`);
        const meta = resp.headers.get("x-test-download-meta");
        if (meta === null || !meta.includes("sample-lines"))
          throw new Error(`missing download meta header`);
      },
    },

    // ── endpoint: HTTP contract ──────────────────────────────────────────────
    {
      name: "nonexistent-unit-returns-404",
      category: "endpoint",
      run: async (baseUrl) => {
        const resp = await httpGet(apiUrl(baseUrl, "this-unit-does-not-exist"));
        if (resp.status !== 404)
          throw new Error(`expected 404 for nonexistent unit, got ${resp.status}`);
      },
    },
    {
      name: "response-content-type-is-json",
      category: "endpoint",
      run: async (baseUrl) => {
        const resp = await fetch(apiUrl(baseUrl, "echo"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ check: "content-type" }),
        });
        const ct = resp.headers.get("content-type") ?? "";
        if (!ct.includes("application/json"))
          throw new Error(`expected application/json content-type, got "${ct}"`);
      },
    },
    {
      name: "wrong-project-returns-404",
      category: "endpoint",
      run: async (baseUrl) => {
        const resp = await httpGet(apiWrongProjectUrl(baseUrl, "echo"));
        if (resp.status !== 404)
          throw new Error(`expected 404 for wrong project, got ${resp.status}`);
      },
    },
    {
      name: "nonexistent-stage-runtime-returns-404",
      category: "endpoint",
      run: async (baseUrl) => {
        const resp = await httpGet(apiStageUrl(baseUrl, "echo", NONEXISTENT_RUNTIME_ID));
        if (resp.status !== 404)
          throw new Error(`expected 404 for nonexistent stage runtime, got ${resp.status}`);
      },
    },
    {
      name: "echo-large-payload-roundtrip",
      category: "endpoint",
      run: async (baseUrl) => {
        const big: Record<string, string> = {};
        for (let i = 0; i < 100; i++) {
          big[`key_${i}`] = "x".repeat(200);
        }
        const resp = await httpPost(apiUrl(baseUrl, "echo"), big);
        if (resp.status !== 200)
          throw new Error(`expected 200 for large payload, got ${resp.status}`);
        const echoed = (resp.body as Record<string, unknown>)["echoed"] as Record<string, unknown> | undefined;
        if (echoed?.["key_0"] !== "x".repeat(200))
          throw new Error("large payload not echoed correctly");
      },
    },
    {
      name: "multiple-sequential-requests-work-independently",
      category: "endpoint",
      run: async (baseUrl) => {
        const payloads = [{ id: 1 }, { id: 2 }, { id: 3 }];
        for (const p of payloads) {
          const resp = await httpPost(apiUrl(baseUrl, "echo"), p);
          if (resp.status !== 200)
            throw new Error(`expected 200 for payload ${p.id}, got ${resp.status}`);
          const echoed = (resp.body as Record<string, unknown>)["echoed"] as Record<string, unknown> | undefined;
          if (echoed?.["id"] !== p.id)
            throw new Error(`expected echoed.id ${p.id}, got ${String(echoed?.["id"])}`);
        }
      },
    },

    // ── isolation: runtime-scope stage overrides ─────────────────────────────
    {
      name: "production-runtime-serves-production-scope",
      category: "isolation",
      run: async (baseUrl) => {
        const resp = await httpGet(apiUrl(baseUrl, "runtime-scope"));
        if (resp.status !== 200)
          throw new Error(`expected 200, got ${resp.status}`);
        const scope = (resp.body as Record<string, unknown>)["scope"];
        if (scope !== "production")
          throw new Error(`expected scope "production", got "${String(scope)}"`);
      },
    },
    {
      name: "stage-a-runtime-serves-stage-a-scope",
      category: "isolation",
      run: async (baseUrl) => {
        const resp = await httpGet(apiStageUrl(baseUrl, "runtime-scope", STAGE_RUNTIME_ID));
        if (resp.status !== 200)
          throw new Error(`expected 200, got ${resp.status}`);
        const scope = (resp.body as Record<string, unknown>)["scope"];
        if (scope !== "stage-a")
          throw new Error(`expected scope "stage-a", got "${String(scope)}"`);
      },
    },
    {
      name: "stage-b-runtime-serves-stage-b-scope",
      category: "isolation",
      run: async (baseUrl) => {
        const resp = await httpGet(apiStageUrl(baseUrl, "runtime-scope", STAGE_B_RUNTIME_ID));
        if (resp.status !== 200)
          throw new Error(`expected 200, got ${resp.status}`);
        const scope = (resp.body as Record<string, unknown>)["scope"];
        if (scope !== "stage-b")
          throw new Error(`expected scope "stage-b", got "${String(scope)}"`);
      },
    },
    {
      name: "production-runtime-does-not-serve-stage-a-scope",
      category: "isolation",
      run: async (baseUrl) => {
        const resp = await httpGet(apiUrl(baseUrl, "runtime-scope"));
        if (resp.status !== 200)
          throw new Error(`expected 200, got ${resp.status}`);
        const scope = (resp.body as Record<string, unknown>)["scope"];
        if (scope === "stage-a" || scope === "stage-b")
          throw new Error(`production runtime leaked stage scope: "${String(scope)}"`);
      },
    },
    {
      name: "stage-a-runtime-does-not-serve-stage-b-scope",
      category: "isolation",
      run: async (baseUrl) => {
        const resp = await httpGet(apiStageUrl(baseUrl, "runtime-scope", STAGE_RUNTIME_ID));
        if (resp.status !== 200)
          throw new Error(`expected 200, got ${resp.status}`);
        const scope = (resp.body as Record<string, unknown>)["scope"];
        if (scope === "stage-b")
          throw new Error(`stage-a runtime served stage-b scope`);
        if (scope === "production")
          throw new Error(`stage-a runtime fell back to production scope (override not applied)`);
      },
    },
    {
      name: "stage-b-runtime-does-not-serve-stage-a-scope",
      category: "isolation",
      run: async (baseUrl) => {
        const resp = await httpGet(apiStageUrl(baseUrl, "runtime-scope", STAGE_B_RUNTIME_ID));
        if (resp.status !== 200)
          throw new Error(`expected 200, got ${resp.status}`);
        const scope = (resp.body as Record<string, unknown>)["scope"];
        if (scope === "stage-a")
          throw new Error(`stage-b runtime served stage-a scope`);
        if (scope === "production")
          throw new Error(`stage-b runtime fell back to production scope (override not applied)`);
      },
    },
    {
      name: "stage-a-and-stage-b-serve-different-scopes",
      category: "isolation",
      run: async (baseUrl) => {
        const [ra, rb] = await Promise.all([
          httpGet(apiStageUrl(baseUrl, "runtime-scope", STAGE_RUNTIME_ID)),
          httpGet(apiStageUrl(baseUrl, "runtime-scope", STAGE_B_RUNTIME_ID)),
        ]);
        const scopeA = (ra.body as Record<string, unknown>)["scope"];
        const scopeB = (rb.body as Record<string, unknown>)["scope"];
        if (scopeA === scopeB)
          throw new Error(`stage-a and stage-b served the same scope "${String(scopeA)}" — runtimes are not isolated`);
      },
    },
    {
      name: "production-and-stage-a-serve-different-scopes",
      category: "isolation",
      run: async (baseUrl) => {
        const [rprod, rstage] = await Promise.all([
          httpGet(apiUrl(baseUrl, "runtime-scope")),
          httpGet(apiStageUrl(baseUrl, "runtime-scope", STAGE_RUNTIME_ID)),
        ]);
        const scopeProd = (rprod.body as Record<string, unknown>)["scope"];
        const scopeStage = (rstage.body as Record<string, unknown>)["scope"];
        if (scopeProd === scopeStage)
          throw new Error(`production and stage-a served the same scope "${String(scopeProd)}" — runtimes are not isolated`);
      },
    },

    // ── sdk-runtime-scope: getApiUnitTriggerUrl correctness per runtime ───────
    // These tests hit the `get-api-trigger-url` unit from different runtimes
    // and verify that the SDK's URL builder is runtime-context-aware.
    {
      name: "getApiTriggerUrl-from-production-is-production-url",
      category: "sdk-runtime-scope",
      run: async (baseUrl) => {
        const resp = await httpGet(apiUrl(baseUrl, "get-api-trigger-url"));
        if (resp.status !== 200)
          throw new Error(`expected 200, got ${resp.status}`);
        const url = String((resp.body as Record<string, unknown>)["url"] ?? "");
        if (url.includes("/stage/"))
          throw new Error(`production runtime returned a stage URL: ${url}`);
        if (!url.includes("/test/api-tests/echo"))
          throw new Error(`URL does not reference echo unit: ${url}`);
      },
    },
    {
      name: "getApiTriggerUrl-from-stage-a-is-stage-a-url",
      category: "sdk-runtime-scope",
      run: async (baseUrl) => {
        const resp = await httpGet(apiStageUrl(baseUrl, "get-api-trigger-url", STAGE_RUNTIME_ID));
        if (resp.status !== 200)
          throw new Error(`expected 200, got ${resp.status}`);
        const url = String((resp.body as Record<string, unknown>)["url"] ?? "");
        if (!url.includes(`/stage/${STAGE_RUNTIME_ID}/`))
          throw new Error(`stage-a runtime did not return stage-a URL: ${url}`);
        if (!url.includes("/test/api-tests/echo"))
          throw new Error(`URL does not reference echo unit: ${url}`);
      },
    },
    {
      name: "getApiTriggerUrl-from-stage-b-is-stage-b-url",
      category: "sdk-runtime-scope",
      run: async (baseUrl) => {
        const resp = await httpGet(apiStageUrl(baseUrl, "get-api-trigger-url", STAGE_B_RUNTIME_ID));
        if (resp.status !== 200)
          throw new Error(`expected 200, got ${resp.status}`);
        const url = String((resp.body as Record<string, unknown>)["url"] ?? "");
        if (!url.includes(`/stage/${STAGE_B_RUNTIME_ID}/`))
          throw new Error(`stage-b runtime did not return stage-b URL: ${url}`);
        if (!url.includes("/test/api-tests/echo"))
          throw new Error(`URL does not reference echo unit: ${url}`);
      },
    },
    {
      name: "getApiTriggerUrl-stage-a-and-stage-b-produce-different-urls",
      category: "sdk-runtime-scope",
      run: async (baseUrl) => {
        const [ra, rb] = await Promise.all([
          httpGet(apiStageUrl(baseUrl, "get-api-trigger-url", STAGE_RUNTIME_ID)),
          httpGet(apiStageUrl(baseUrl, "get-api-trigger-url", STAGE_B_RUNTIME_ID)),
        ]);
        const urlA = String((ra.body as Record<string, unknown>)["url"] ?? "");
        const urlB = String((rb.body as Record<string, unknown>)["url"] ?? "");
        if (urlA === urlB)
          throw new Error(`stage-a and stage-b produced the same SDK URL: ${urlA}`);
        if (!urlA.includes(STAGE_RUNTIME_ID))
          throw new Error(`stage-a URL missing stage-a runtime id: ${urlA}`);
        if (!urlB.includes(STAGE_B_RUNTIME_ID))
          throw new Error(`stage-b URL missing stage-b runtime id: ${urlB}`);
      },
    },

    // ── sdk-cross-unit: API → API via sdk.getApiUnitTriggerUrl ───────────────
    {
      name: "api-to-api-via-sdk-url-works",
      category: "sdk-cross-unit",
      run: async (baseUrl) => {
        const resp = await httpPost(apiUrl(baseUrl, "api-to-api-via-sdk"));
        if (resp.status !== 200)
          throw new Error(`expected 200, got ${resp.status}`);
        const body = resp.body as Record<string, unknown>;
        const echoed = body["echoed"] as Record<string, unknown> | undefined;
        if (echoed?.["via"] !== "sdk-url")
          throw new Error(`expected echoed.via "sdk-url", got ${JSON.stringify(echoed)}`);
      },
    },
    {
      name: "api-to-api-via-sdk-url-from-stage-a-is-scoped",
      category: "sdk-cross-unit",
      run: async (baseUrl) => {
        const resp = await httpPost(apiStageUrl(baseUrl, "api-to-api-via-sdk", STAGE_RUNTIME_ID));
        if (resp.status !== 200)
          throw new Error(`expected 200, got ${resp.status}`);
        const body = resp.body as Record<string, unknown>;
        const url = String(body["url"] ?? "");
        // The URL used by the unit must be the stage-a URL, not the production URL
        if (!url.includes(`/stage/${STAGE_RUNTIME_ID}/`))
          throw new Error(`api-to-api from stage-a did not use stage-a URL: ${url}`);
        // The echo call also worked (no error, body has echoed)
        const echoed = body["echoed"] as Record<string, unknown> | undefined;
        if (echoed?.["via"] !== "sdk-url")
          throw new Error(`expected echoed.via "sdk-url", got ${JSON.stringify(echoed)}`);
      },
    },

    // ── sdk-cross-unit: API → Actor ───────────────────────────────────────────
    {
      name: "call-actor-sync-increment-returns-correct-count",
      category: "sdk-cross-unit",
      run: async (baseUrl) => {
        const actorId = `actor-sync-${runTag}`;
        const resp = await httpPost(apiUrl(baseUrl, "call-actor-sync"), {
          actorId,
          handler: "increment",
          by: 7,
        });
        if (resp.status !== 200)
          throw new Error(`expected 200, got ${resp.status}`);
        const count = (resp.body as Record<string, unknown>)["count"];
        if (count !== 7)
          throw new Error(`expected count 7 on fresh actor, got ${String(count)}`);
      },
    },
    {
      name: "call-actor-sync-reset-then-increment-gives-exact-count",
      category: "sdk-cross-unit",
      run: async (baseUrl) => {
        const actorId = `actor-reset-${runTag}`;
        // Increment first so state is dirty
        await httpPost(apiUrl(baseUrl, "call-actor-sync"), { actorId, handler: "increment", by: 99 });
        // Reset to 0
        const resetResp = await httpPost(apiUrl(baseUrl, "call-actor-sync"), { actorId, handler: "reset" });
        if (resetResp.status !== 200)
          throw new Error(`reset failed: ${resetResp.status}`);
        if ((resetResp.body as Record<string, unknown>)["count"] !== 0)
          throw new Error(`expected count 0 after reset, got ${String((resetResp.body as Record<string, unknown>)["count"])}`);
        // Increment by 3
        const incResp = await httpPost(apiUrl(baseUrl, "call-actor-sync"), { actorId, handler: "increment", by: 3 });
        if (incResp.status !== 200)
          throw new Error(`increment after reset failed: ${incResp.status}`);
        if ((incResp.body as Record<string, unknown>)["count"] !== 3)
          throw new Error(`expected count 3 after reset+increment, got ${String((incResp.body as Record<string, unknown>)["count"])}`);
      },
    },
    {
      name: "call-actor-sync-get-returns-current-state",
      category: "sdk-cross-unit",
      run: async (baseUrl) => {
        const actorId = `actor-get-${runTag}`;
        // Set a known state
        await httpPost(apiUrl(baseUrl, "call-actor-sync"), { actorId, handler: "increment", by: 5 });
        // Read it back
        const resp = await httpPost(apiUrl(baseUrl, "call-actor-sync"), { actorId, handler: "get" });
        if (resp.status !== 200)
          throw new Error(`expected 200, got ${resp.status}`);
        const count = (resp.body as Record<string, unknown>)["count"];
        if (count !== 5)
          throw new Error(`expected count 5, got ${String(count)}`);
      },
    },
    {
      name: "call-actor-sync-different-actor-ids-have-independent-state",
      category: "sdk-cross-unit",
      run: async (baseUrl) => {
        const idA = `actor-iso-a-${runTag}`;
        const idB = `actor-iso-b-${runTag}`;
        await httpPost(apiUrl(baseUrl, "call-actor-sync"), { actorId: idA, handler: "increment", by: 10 });
        await httpPost(apiUrl(baseUrl, "call-actor-sync"), { actorId: idB, handler: "increment", by: 20 });
        const [rA, rB] = await Promise.all([
          httpPost(apiUrl(baseUrl, "call-actor-sync"), { actorId: idA, handler: "get" }),
          httpPost(apiUrl(baseUrl, "call-actor-sync"), { actorId: idB, handler: "get" }),
        ]);
        if ((rA.body as Record<string, unknown>)["count"] !== 10)
          throw new Error(`actor A count mismatch: ${String((rA.body as Record<string, unknown>)["count"])}`);
        if ((rB.body as Record<string, unknown>)["count"] !== 20)
          throw new Error(`actor B count mismatch: ${String((rB.body as Record<string, unknown>)["count"])}`);
      },
    },
    {
      name: "send-actor-msg-returns-delivered-true",
      category: "sdk-cross-unit",
      run: async (baseUrl) => {
        const actorId = `actor-faf-${runTag}`;
        const resp = await httpPost(apiUrl(baseUrl, "send-actor-msg"), { actorId, by: 3 });
        if (resp.status !== 200)
          throw new Error(`expected 200, got ${resp.status}`);
        const delivered = (resp.body as Record<string, unknown>)["delivered"];
        if (delivered !== true)
          throw new Error(`expected delivered true, got ${String(delivered)}`);
      },
    },

    // ── sdk-cross-unit: API → Queue Worker ───────────────────────────────────
    {
      name: "enqueue-worker-returns-non-empty-run-id",
      category: "sdk-cross-unit",
      run: async (baseUrl) => {
        const resp = await httpPost(apiUrl(baseUrl, "enqueue-worker"), { data: { probe: "test" } });
        if (resp.status !== 200)
          throw new Error(`expected 200, got ${resp.status}`);
        const runId = (resp.body as Record<string, unknown>)["runId"];
        if (typeof runId !== "string" || runId.length === 0)
          throw new Error(`expected non-empty runId string, got ${JSON.stringify(runId)}`);
      },
    },
    {
      name: "enqueue-worker-returns-unique-run-ids",
      category: "sdk-cross-unit",
      run: async (baseUrl) => {
        const [r1, r2] = await Promise.all([
          httpPost(apiUrl(baseUrl, "enqueue-worker"), { data: { n: 1 } }),
          httpPost(apiUrl(baseUrl, "enqueue-worker"), { data: { n: 2 } }),
        ]);
        if (r1.status !== 200 || r2.status !== 200)
          throw new Error(`expected 200 for both enqueues, got ${r1.status} / ${r2.status}`);
        const id1 = (r1.body as Record<string, unknown>)["runId"];
        const id2 = (r2.body as Record<string, unknown>)["runId"];
        if (id1 === id2)
          throw new Error(`two enqueue calls returned the same runId: ${String(id1)}`);
      },
    },
    {
      name: "enqueue-worker-accepts-empty-data",
      category: "sdk-cross-unit",
      run: async (baseUrl) => {
        const resp = await httpPost(apiUrl(baseUrl, "enqueue-worker"), {});
        if (resp.status !== 200)
          throw new Error(`expected 200 for empty data enqueue, got ${resp.status}`);
        const runId = (resp.body as Record<string, unknown>)["runId"];
        if (typeof runId !== "string" || runId.length === 0)
          throw new Error(`expected runId for empty data enqueue`);
      },
    },

    // ── sdk-cross-unit: API → Workflow ───────────────────────────────────────
    {
      name: "start-workflow-ff-returns-instance-id",
      category: "sdk-cross-unit",
      run: async (baseUrl) => {
        const resp = await httpPost(apiUrl(baseUrl, "start-workflow-ff"), { value: "fire-and-forget" });
        if (resp.status !== 200)
          throw new Error(`expected 200, got ${resp.status}`);
        const instanceId = (resp.body as Record<string, unknown>)["instanceId"];
        if (typeof instanceId !== "string" || instanceId.length === 0)
          throw new Error(`expected non-empty instanceId, got ${JSON.stringify(instanceId)}`);
      },
    },
    {
      name: "start-workflow-ff-multiple-calls-produce-unique-instance-ids",
      category: "sdk-cross-unit",
      run: async (baseUrl) => {
        const [r1, r2] = await Promise.all([
          httpPost(apiUrl(baseUrl, "start-workflow-ff"), { value: "x" }),
          httpPost(apiUrl(baseUrl, "start-workflow-ff"), { value: "y" }),
        ]);
        if (r1.status !== 200 || r2.status !== 200)
          throw new Error(`expected 200 for both starts, got ${r1.status} / ${r2.status}`);
        const id1 = (r1.body as Record<string, unknown>)["instanceId"];
        const id2 = (r2.body as Record<string, unknown>)["instanceId"];
        if (id1 === id2)
          throw new Error(`two workflow starts returned the same instanceId: ${String(id1)}`);
      },
    },
    {
      name: "call-workflow-returns-echoed-value",
      category: "sdk-cross-unit",
      run: async (baseUrl) => {
        const resp = await httpPost(apiUrl(baseUrl, "call-workflow"), { value: "round-trip-42" });
        if (resp.status !== 200)
          throw new Error(`expected 200, got ${resp.status}`);
        const echoed = (resp.body as Record<string, unknown>)["echoed"];
        if (echoed !== "round-trip-42")
          throw new Error(`expected echoed "round-trip-42", got ${JSON.stringify(echoed)}`);
      },
    },
    {
      name: "call-workflow-echoes-object-value",
      category: "sdk-cross-unit",
      run: async (baseUrl) => {
        const input = { nested: { x: 1, y: [2, 3] } };
        const resp = await httpPost(apiUrl(baseUrl, "call-workflow"), { value: input });
        if (resp.status !== 200)
          throw new Error(`expected 200, got ${resp.status}`);
        const echoed = (resp.body as Record<string, unknown>)["echoed"];
        const e = echoed as Record<string, unknown> | undefined;
        const nested = e?.["nested"] as Record<string, unknown> | undefined;
        if (nested?.["x"] !== 1)
          throw new Error(`workflow did not echo object correctly: ${JSON.stringify(echoed)}`);
      },
    },
    {
      name: "call-workflow-echoes-null-value",
      category: "sdk-cross-unit",
      run: async (baseUrl) => {
        const resp = await httpPost(apiUrl(baseUrl, "call-workflow"), { value: null });
        if (resp.status !== 200)
          throw new Error(`expected 200, got ${resp.status}`);
        const echoed = (resp.body as Record<string, unknown>)["echoed"];
        if (echoed !== null)
          throw new Error(`expected null echoed, got ${JSON.stringify(echoed)}`);
      },
    },
    {
      name: "call-workflow-handler-echo-then-finish",
      category: "sdk-cross-unit",
      run: async (baseUrl) => {
        const msg = `handler-api-${runTag}`;
        const resp = await httpPost(apiUrl(baseUrl, "call-workflow-handler"), { msg });
        if (resp.status !== 200)
          throw new Error(`expected 200, got ${resp.status}`);
        const body = resp.body as Record<string, unknown>;
        if (typeof body["instanceId"] !== "string" || String(body["instanceId"]).length === 0)
          throw new Error(`expected instanceId, got ${JSON.stringify(body["instanceId"])}`);
        const echo = body["handlerEcho"] as Record<string, unknown> | undefined;
        if (echo?.["echoed"] !== msg)
          throw new Error(`handler echo mismatch: ${JSON.stringify(echo)}`);
        const fin = body["handlerFinish"] as Record<string, unknown> | undefined;
        if (fin?.["closed"] !== true)
          throw new Error(`finish handler mismatch: ${JSON.stringify(fin)}`);
      },
    },
    {
      name: "call-workflow-handler-from-stage-a",
      category: "sdk-cross-unit",
      run: async (baseUrl) => {
        const resp = await httpPost(
          apiStageUrl(baseUrl, "call-workflow-handler", STAGE_RUNTIME_ID),
          { msg: "stage-a-handler" },
        );
        if (resp.status !== 200)
          throw new Error(`expected 200 from stage-a, got ${resp.status}`);
        const echo = (resp.body as Record<string, unknown>)["handlerEcho"] as Record<string, unknown> | undefined;
        if (echo?.["echoed"] !== "stage-a-handler")
          throw new Error(`stage-a handler echo wrong: ${JSON.stringify(echo)}`);
      },
    },

    // ── sdk-cross-unit: stage runtime scoping for SDK calls ──────────────────
    // Ensures that SDK calls issued from a stage runtime are routed within
    // that stage's scope and do not bleed into other runtimes.
    {
      name: "call-actor-sync-from-stage-a-is-isolated-from-production",
      category: "sdk-cross-unit",
      run: async (baseUrl) => {
        const actorId = `actor-stgiso-${runTag}`;
        // Increment from production (count = 5)
        await httpPost(apiUrl(baseUrl, "call-actor-sync"), { actorId, handler: "increment", by: 5 });
        // Increment from stage-a on the same actorId (must be a different actor instance — different Redis key)
        const stageResp = await httpPost(
          apiStageUrl(baseUrl, "call-actor-sync", STAGE_RUNTIME_ID),
          { actorId, handler: "increment", by: 3 },
        );
        if (stageResp.status !== 200)
          throw new Error(`stage-a actor call failed: ${stageResp.status}`);
        // Stage-a state is fresh — count must be 3, not 8 (prod + stage combined)
        const stageCount = (stageResp.body as Record<string, unknown>)["count"];
        if (stageCount !== 3)
          throw new Error(`stage-a actor state polluted by production (expected 3, got ${String(stageCount)})`);
      },
    },
    {
      name: "call-actor-sync-from-stage-b-is-isolated-from-stage-a",
      category: "sdk-cross-unit",
      run: async (baseUrl) => {
        const actorId = `actor-stgb-${runTag}`;
        // Set distinct counts on stage-a and stage-b for the same actorId
        await httpPost(apiStageUrl(baseUrl, "call-actor-sync", STAGE_RUNTIME_ID), { actorId, handler: "increment", by: 11 });
        const stageBResp = await httpPost(
          apiStageUrl(baseUrl, "call-actor-sync", STAGE_B_RUNTIME_ID),
          { actorId, handler: "increment", by: 22 },
        );
        if (stageBResp.status !== 200)
          throw new Error(`stage-b actor call failed: ${stageBResp.status}`);
        const stageBCount = (stageBResp.body as Record<string, unknown>)["count"];
        if (stageBCount !== 22)
          throw new Error(`stage-b actor state polluted by stage-a (expected 22, got ${String(stageBCount)})`);
        // Also check stage-a state is still 11
        const stageAResp = await httpPost(
          apiStageUrl(baseUrl, "call-actor-sync", STAGE_RUNTIME_ID),
          { actorId, handler: "get" },
        );
        const stageACount = (stageAResp.body as Record<string, unknown>)["count"];
        if (stageACount !== 11)
          throw new Error(`stage-a actor state polluted by stage-b (expected 11, got ${String(stageACount)})`);
      },
    },
    {
      name: "enqueue-worker-from-stage-a-succeeds",
      category: "sdk-cross-unit",
      run: async (baseUrl) => {
        const resp = await httpPost(
          apiStageUrl(baseUrl, "enqueue-worker", STAGE_RUNTIME_ID),
          { data: { from: "stage-a" } },
        );
        if (resp.status !== 200)
          throw new Error(`expected 200 from stage-a enqueue, got ${resp.status}`);
        const runId = (resp.body as Record<string, unknown>)["runId"];
        if (typeof runId !== "string" || runId.length === 0)
          throw new Error(`expected non-empty runId from stage-a enqueue`);
      },
    },
    {
      name: "call-workflow-from-stage-a-returns-correct-output",
      category: "sdk-cross-unit",
      run: async (baseUrl) => {
        const resp = await httpPost(
          apiStageUrl(baseUrl, "call-workflow", STAGE_RUNTIME_ID),
          { value: "stage-a-workflow-check" },
        );
        if (resp.status !== 200)
          throw new Error(`expected 200 from stage-a workflow call, got ${resp.status}`);
        const echoed = (resp.body as Record<string, unknown>)["echoed"];
        if (echoed !== "stage-a-workflow-check")
          throw new Error(`stage-a workflow returned wrong output: ${JSON.stringify(echoed)}`);
      },
    },

    // ── timeout: unit execution deadline enforcement ──────────────────────────
    // `metadata.timeout_seconds`: custom value, absent, 0, null, non-integer → e2e below.
    // These tests verify that the platform closes a hanging unit's response
    // within the configured (or default) timeout instead of holding the
    // connection open indefinitely.
    //
    // Implementation note: we use Promise.race with a local timer so the test
    // runner itself is not blocked. The inner fetch runs in the background;
    // if it resolves (any status) or rejects (connection closed by platform)
    // before our deadline, the test passes. If our deadline fires first, it
    // means the platform did NOT enforce the configured timeout.
    {
      name: "custom-timeout-enforced-within-deadline",
      category: "timeout",
      run: async (baseUrl) => {
        // custom-short-timeout row has metadata.timeout_seconds = 2 (seeded in Rust).
        // We give the platform 5 s of grace — well above 2 s, well below 30 s.
        // If the platform honours the custom timeout, the fetch resolves or
        // the connection closes within ~2 s. If not, our 5-second local timer
        // fires and we fail.
        const DEADLINE_MS = 5_000;
        let platformResponded = false;
        await new Promise<void>((resolve, reject) => {
          let deadline: ReturnType<typeof setTimeout> | undefined;
          void fetch(apiUrl(baseUrl, "custom-short-timeout"))
            .then(() => {
              platformResponded = true;
              if (deadline !== undefined) clearTimeout(deadline);
              resolve();
            })
            .catch(() => {
              platformResponded = true;
              if (deadline !== undefined) clearTimeout(deadline);
              resolve();
            });
          deadline = setTimeout(() => {
            if (!platformResponded) {
              reject(new Error(
                `custom row metadata.timeout_seconds = 2 was NOT enforced — ` +
                `connection still open after ${DEADLINE_MS} ms`,
              ));
            }
          }, DEADLINE_MS);
        });
      },
    },
    {
      name: "custom-timeout-stage-a-enforced",
      category: "timeout",
      run: async (baseUrl) => {
        const DEADLINE_MS = 5_000;
        let platformResponded = false;
        await new Promise<void>((resolve, reject) => {
          let deadline: ReturnType<typeof setTimeout> | undefined;
          void fetch(apiStageUrl(baseUrl, "custom-short-timeout", STAGE_RUNTIME_ID))
            .then(() => {
              platformResponded = true;
              if (deadline !== undefined) clearTimeout(deadline);
              resolve();
            })
            .catch(() => {
              platformResponded = true;
              if (deadline !== undefined) clearTimeout(deadline);
              resolve();
            });
          deadline = setTimeout(() => {
            if (!platformResponded) {
              reject(new Error(
                `custom timeout NOT enforced on stage-A runtime after ${DEADLINE_MS} ms`,
              ));
            }
          }, DEADLINE_MS);
        });
      },
    },
    {
      name: "normal-unit-is-not-prematurely-killed",
      category: "timeout",
      run: async (baseUrl) => {
        // A unit that finishes quickly must NOT be killed before it responds.
        // This is the complementary check: the timeout must only fire on units
        // that genuinely exceed the deadline.
        const resp = await httpPost(apiUrl(baseUrl, "echo"), { check: "not-killed" });
        if (resp.status !== 200)
          throw new Error(`fast unit was killed before responding (status ${resp.status})`);
        const echoed = (resp.body as Record<string, unknown>)["echoed"] as Record<string, unknown> | undefined;
        if (echoed?.["check"] !== "not-killed")
          throw new Error(`fast unit response body is wrong: ${JSON.stringify(echoed)}`);
      },
    },
    {
      name: "metadata-timeout-seconds-field-is-valid-type",
      category: "timeout",
      run: async (baseUrl) => {
        // Verify row metadata.timeout_seconds = 2 does not break routing.
        // We just check the unit returns any HTTP response at all before our deadline.
        const DEADLINE_MS = 5_000;
        let reachable = false;
        await new Promise<void>((resolve, reject) => {
          let deadline: ReturnType<typeof setTimeout> | undefined;
          void fetch(apiUrl(baseUrl, "custom-short-timeout"))
            .then(() => { reachable = true; if (deadline !== undefined) clearTimeout(deadline); resolve(); })
            .catch(() => { reachable = true; if (deadline !== undefined) clearTimeout(deadline); resolve(); });
          deadline = setTimeout(() => {
            if (!reachable) {
              reject(new Error(
                `custom-short-timeout unit was not reachable within ${DEADLINE_MS} ms — ` +
                `check that row metadata.timeout_seconds does not break routing`,
              ));
            }
          }, DEADLINE_MS);
        });
      },
    },
    {
      name: "default-platform-30s-timeout-metadata-scenarios-sequential-e2e",
      category: "timeout",
      run: async (baseUrl) => {
        await expectHangReleasedWithinGrace(
          apiUrl(baseUrl, "hang-forever"),
          "absent timeout_seconds (prod hang-forever)",
        );
        await expectHangReleasedWithinGrace(
          apiStageUrl(baseUrl, "hang-forever"),
          "absent timeout_seconds (stage-A hang-forever)",
        );
        await expectHangReleasedWithinGrace(
          apiUrl(baseUrl, "timeout-seconds-zero"),
          "timeout_seconds = 0 (prod)",
        );
        await expectHangReleasedWithinGrace(
          apiStageUrl(baseUrl, "timeout-seconds-zero"),
          "timeout_seconds = 0 (stage-A)",
        );
        await expectHangReleasedWithinGrace(
          apiUrl(baseUrl, "timeout-seconds-null"),
          "timeout_seconds = null (prod)",
        );
        await expectHangReleasedWithinGrace(
          apiUrl(baseUrl, "timeout-seconds-invalid-type"),
          "timeout_seconds string (invalid type, prod)",
        );
      },
    },
    {
      name: "timeout-seconds-positive-120-honoured-for-fast-unit",
      category: "timeout",
      run: async (baseUrl) => {
        const resp = await httpGet(apiUrl(baseUrl, "long-cap-echo"));
        if (resp.status !== 200)
          throw new Error(`long-cap-echo expected 200, got ${resp.status}`);
      },
    },

  ];
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

async function runTest(baseUrl: string, test: ApiTestDef): Promise<TestResult> {
  const label = `${test.category}: ${test.name}`;
  if (test.skip) {
    return { name: label, pass: true, detail: `SKIPPED: ${test.skip}` };
  }
  try {
    await test.run(baseUrl);
    return { name: label, pass: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { name: label, pass: false, error: msg };
  }
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

  const sectionSummaries: Record<string, unknown> = {};
  const sectionDetails: Record<string, unknown> = {};
  const flatTests: Array<{ name: string; pass: boolean }> = [];

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

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const baseUrl = getBaseUrl(req);

  const tests = allTests();
  const results: TestResult[] = [];
  for (const test of tests) {
    console.log(`  api: ${test.category}: ${test.name} …`);
    results.push(await runTest(baseUrl, test));
  }

  const report = buildReport(results);
  const body = JSON.stringify(report, null, 2);

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(body);
}
