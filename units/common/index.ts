/**
 * Common suite test runner (`test.common.api.index`).
 *
 * Triggers API harness units that import injected common units.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

const PROJECT_ID = "00000000-aaaa-bbbb-cccc-000000000010";
const STAGE_RUNTIME_ID = "00000000-aaaa-bbbb-cccc-000000000022";
const STAGE_B_RUNTIME_ID = "00000000-aaaa-bbbb-cccc-000000000023";

function getBaseUrl(req: IncomingMessage): string {
  const host = req.headers.host ?? "127.0.0.1:3337";
  return `http://${host}`;
}

interface TestResult {
  name: string;
  pass: boolean;
  detail?: string;
  error?: string;
}

interface CommonTestDef {
  name: string;
  category: string;
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

async function httpGet(url: string): Promise<{ status: number; body: unknown }> {
  const resp = await fetch(url);
  const text = await resp.text();
  try {
    return { status: resp.status, body: JSON.parse(text) };
  } catch {
    return { status: resp.status, body: text };
  }
}

async function httpPost(url: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : "{}",
  });
  const text = await resp.text();
  try {
    return { status: resp.status, body: JSON.parse(text) };
  } catch {
    return { status: resp.status, body: text };
  }
}

function apiHarnessUrl(baseUrl: string, slug: string): string {
  return `${baseUrl}/api/v1/trigger/${PROJECT_ID}/test/common/${slug}`;
}

function apiHarnessStageUrl(baseUrl: string, slug: string, runtimeId = STAGE_RUNTIME_ID): string {
  return `${baseUrl}/api/v1/trigger/${PROJECT_ID}/stage/${runtimeId}/test/common/${slug}`;
}

function testRunTag(): string {
  return Date.now().toString(36);
}

function bodyRecord(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null) {
    throw new Error(`expected JSON object, got ${JSON.stringify(body)}`);
  }
  return body as Record<string, unknown>;
}

function allTests(): CommonTestDef[] {
  const runTag = testRunTag();

  return [
    // ── common-imports: api ← common value wiring ───────────────────────────
    {
      name: "basic-sum-uses-logger-and-summer",
      category: "common-imports",
      run: async (baseUrl) => {
        const resp = await httpGet(apiHarnessUrl(baseUrl, "basic-sum"));
        if (resp.status !== 200) throw new Error(`expected 200, got ${resp.status}`);
        const b = bodyRecord(resp.body);
        if (b["loggerFactor"] !== 20) throw new Error(`loggerFactor: ${JSON.stringify(b)}`);
        if (b["summerFactor"] !== 10) throw new Error(`summerFactor: ${JSON.stringify(b)}`);
        if (b["sum"] !== 33) throw new Error(`sum expected 33 (1+2+20+10), got ${JSON.stringify(b)}`);
      },
    },
    {
      name: "export-name-collision-resolves-per-module",
      category: "common-imports",
      run: async (baseUrl) => {
        const resp = await httpGet(apiHarnessUrl(baseUrl, "export-collision"));
        if (resp.status !== 200) throw new Error(`expected 200, got ${resp.status}`);
        const b = bodyRecord(resp.body);
        if (b["alphaToken"] !== "alpha-token") throw new Error(`alphaToken: ${JSON.stringify(b)}`);
        if (b["betaToken"] !== "beta-token") throw new Error(`betaToken: ${JSON.stringify(b)}`);
        if (b["alphaVersion"] !== 1) throw new Error(`alphaVersion: ${JSON.stringify(b)}`);
        if (b["betaVersion"] !== 2) throw new Error(`betaVersion: ${JSON.stringify(b)}`);
      },
    },
    {
      name: "nested-scoped-names-stay-isolated",
      category: "common-imports",
      run: async (baseUrl) => {
        const resp = await httpGet(apiHarnessUrl(baseUrl, "scoped-collision"));
        if (resp.status !== 200) throw new Error(`expected 200, got ${resp.status}`);
        const b = bodyRecord(resp.body);
        if (b["a"] !== 10) throw new Error(`scope a expected 10, got ${JSON.stringify(b)}`);
        if (b["b"] !== 99) throw new Error(`scope b expected 99, got ${JSON.stringify(b)}`);
      },
    },
    {
      name: "nested-export-name-collision-resolves-correctly",
      category: "common-imports",
      run: async (baseUrl) => {
        const resp = await httpGet(apiHarnessUrl(baseUrl, "nested-exports"));
        if (resp.status !== 200) throw new Error(`expected 200, got ${resp.status}`);
        const b = bodyRecord(resp.body);
        if (b["tagA"] !== "leaf-a") throw new Error(`tagA: ${JSON.stringify(b)}`);
        if (b["tagB"] !== "leaf-b") throw new Error(`tagB: ${JSON.stringify(b)}`);
        if (b["total"] !== 106) throw new Error(`total expected 106 (6+100), got ${JSON.stringify(b)}`);
      },
    },
    {
      name: "common-re-exports-resolve-with-aliases",
      category: "common-imports",
      run: async (baseUrl) => {
        const resp = await httpGet(apiHarnessUrl(baseUrl, "re-export-tags"));
        if (resp.status !== 200) throw new Error(`expected 200, got ${resp.status}`);
        const b = bodyRecord(resp.body);
        if (b["tagA"] !== "leaf-a") throw new Error(`tagA: ${JSON.stringify(b)}`);
        if (b["tagB"] !== "leaf-b") throw new Error(`tagB: ${JSON.stringify(b)}`);
      },
    },
    {
      name: "multiple-imports-from-same-common-module",
      category: "common-imports",
      run: async (baseUrl) => {
        const resp = await httpGet(apiHarnessUrl(baseUrl, "double-import"));
        if (resp.status !== 200) throw new Error(`expected 200, got ${resp.status}`);
        const b = bodyRecord(resp.body);
        if (b["factor"] !== 20) throw new Error(`factor: ${JSON.stringify(b)}`);
        if (b["hasLogFn"] !== true) throw new Error(`hasLogFn: ${JSON.stringify(b)}`);
      },
    },

    // ── common-import-forms: import * as / type+value ────────────────────────
    {
      name: "import-ns-star-from-common-module",
      category: "common-import-forms",
      run: async (baseUrl) => {
        const resp = await httpGet(apiHarnessUrl(baseUrl, "import-ns-star"));
        if (resp.status !== 200) throw new Error(`expected 200, got ${resp.status}`);
        const b = bodyRecord(resp.body);
        if (b["token"] !== "alpha-token") throw new Error(`token: ${JSON.stringify(b)}`);
        if (b["version"] !== 1) throw new Error(`version: ${JSON.stringify(b)}`);
      },
    },
    {
      name: "import-ns-star-from-export-star-barrel",
      category: "common-import-forms",
      run: async (baseUrl) => {
        const resp = await httpGet(apiHarnessUrl(baseUrl, "import-ns-barrel"));
        if (resp.status !== 200) throw new Error(`expected 200, got ${resp.status}`);
        const b = bodyRecord(resp.body);
        if (b["token"] !== "alpha-token") throw new Error(`token: ${JSON.stringify(b)}`);
        if (b["version"] !== 1) throw new Error(`version: ${JSON.stringify(b)}`);
      },
    },
    {
      name: "import-type-only-plus-value-import",
      category: "common-import-forms",
      run: async (baseUrl) => {
        const resp = await httpGet(apiHarnessUrl(baseUrl, "import-type-and-value"));
        if (resp.status !== 200) throw new Error(`expected 200, got ${resp.status}`);
        const b = bodyRecord(resp.body);
        if (b["size"] !== "sm") throw new Error(`size: ${JSON.stringify(b)}`);
        if (b["tagMatches"] !== true) throw new Error(`tagMatches: ${JSON.stringify(b)}`);
      },
    },

    // ── common-export-forms: export * / namespace / inline / local ───────────
    {
      name: "export-star-re-exports-all-bindings",
      category: "common-export-forms",
      run: async (baseUrl) => {
        const resp = await httpGet(apiHarnessUrl(baseUrl, "export-star"));
        if (resp.status !== 200) throw new Error(`expected 200, got ${resp.status}`);
        const b = bodyRecord(resp.body);
        if (b["token"] !== "alpha-token") throw new Error(`token: ${JSON.stringify(b)}`);
        if (b["version"] !== 1) throw new Error(`version: ${JSON.stringify(b)}`);
      },
    },
    {
      name: "export-named-list-re-exports",
      category: "common-export-forms",
      run: async (baseUrl) => {
        const resp = await httpGet(apiHarnessUrl(baseUrl, "export-named"));
        if (resp.status !== 200) throw new Error(`expected 200, got ${resp.status}`);
        const b = bodyRecord(resp.body);
        if (b["token"] !== "alpha-token") throw new Error(`token: ${JSON.stringify(b)}`);
        if (b["version"] !== 1) throw new Error(`version: ${JSON.stringify(b)}`);
      },
    },
    {
      name: "export-ns-re-exports-as-namespace",
      category: "common-export-forms",
      run: async (baseUrl) => {
        const resp = await httpGet(apiHarnessUrl(baseUrl, "export-ns"));
        if (resp.status !== 200) throw new Error(`expected 200, got ${resp.status}`);
        const b = bodyRecord(resp.body);
        if (b["token"] !== "alpha-token") throw new Error(`token: ${JSON.stringify(b)}`);
        if (b["version"] !== 1) throw new Error(`version: ${JSON.stringify(b)}`);
      },
    },
    {
      name: "export-star-plus-named-aliases",
      category: "common-export-forms",
      run: async (baseUrl) => {
        const resp = await httpGet(apiHarnessUrl(baseUrl, "export-mixed-barrel"));
        if (resp.status !== 200) throw new Error(`expected 200, got ${resp.status}`);
        const b = bodyRecord(resp.body);
        if (b["alphaToken"] !== "alpha-token") throw new Error(`alphaToken: ${JSON.stringify(b)}`);
        if (b["betaToken"] !== "beta-token") throw new Error(`betaToken: ${JSON.stringify(b)}`);
        if (b["alphaVersion"] !== 1) throw new Error(`alphaVersion: ${JSON.stringify(b)}`);
        if (b["betaVersion"] !== 2) throw new Error(`betaVersion: ${JSON.stringify(b)}`);
      },
    },
    {
      name: "export-inline-const-and-function",
      category: "common-export-forms",
      run: async (baseUrl) => {
        const resp = await httpGet(apiHarnessUrl(baseUrl, "export-inline"));
        if (resp.status !== 200) throw new Error(`expected 200, got ${resp.status}`);
        const b = bodyRecord(resp.body);
        if (b["label"] !== "inline-export") throw new Error(`label: ${JSON.stringify(b)}`);
        if (b["joined"] !== "x:y") throw new Error(`joined: ${JSON.stringify(b)}`);
      },
    },
    {
      name: "export-from-local-binding",
      category: "common-export-forms",
      run: async (baseUrl) => {
        const resp = await httpGet(apiHarnessUrl(baseUrl, "export-from-local"));
        if (resp.status !== 200) throw new Error(`expected 200, got ${resp.status}`);
        const b = bodyRecord(resp.body);
        if (b["value"] !== 42) throw new Error(`value: ${JSON.stringify(b)}`);
        if (b["doubled"] !== 84) throw new Error(`doubled: ${JSON.stringify(b)}`);
      },
    },
    {
      name: "export-type-and-value-together",
      category: "common-export-forms",
      run: async (baseUrl) => {
        const resp = await httpGet(apiHarnessUrl(baseUrl, "export-type-value"));
        if (resp.status !== 200) throw new Error(`expected 200, got ${resp.status}`);
        const b = bodyRecord(resp.body);
        if (b["size"] !== "sm") throw new Error(`size: ${JSON.stringify(b)}`);
        if (b["large"] !== false) throw new Error(`large: ${JSON.stringify(b)}`);
      },
    },
    {
      name: "common-stage-value-production",
      category: "common-imports",
      run: async (baseUrl) => {
        const resp = await httpGet(apiHarnessUrl(baseUrl, "read-stage-value"));
        if (resp.status !== 200) throw new Error(`expected 200, got ${resp.status}`);
        if (bodyRecord(resp.body)["marker"] !== "production")
          throw new Error(`expected production marker`);
      },
    },
    {
      name: "common-stage-value-stage-a",
      category: "common-imports",
      run: async (baseUrl) => {
        const resp = await httpGet(apiHarnessStageUrl(baseUrl, "read-stage-value", STAGE_RUNTIME_ID));
        if (resp.status !== 200) throw new Error(`expected 200, got ${resp.status}`);
        if (bodyRecord(resp.body)["marker"] !== "stage-a")
          throw new Error(`expected stage-a marker`);
      },
    },
    {
      name: "common-stage-value-stage-b",
      category: "common-imports",
      run: async (baseUrl) => {
        const resp = await httpGet(apiHarnessStageUrl(baseUrl, "read-stage-value", STAGE_B_RUNTIME_ID));
        if (resp.status !== 200) throw new Error(`expected 200, got ${resp.status}`);
        if (bodyRecord(resp.body)["marker"] !== "stage-b")
          throw new Error(`expected stage-b marker`);
      },
    },

    // ── common-in-unit-types: actor / workflow / queue_worker ← common ───────
    {
      name: "actor-handler-imports-common-offset",
      category: "common-in-unit-types",
      run: async (baseUrl) => {
        const actorId = `offset-common-${runTag}`;
        const resp = await httpPost(apiHarnessUrl(baseUrl, "actor-with-common"), { actorId, by: 1 });
        if (resp.status !== 200) throw new Error(`expected 200, got ${resp.status}`);
        if (bodyRecord(resp.body)["count"] !== 8)
          throw new Error(`expected count 8 (0+1+7 offset), got ${JSON.stringify(resp.body)}`);
      },
    },
    {
      name: "workflow-step-imports-common-offset",
      category: "common-in-unit-types",
      run: async (baseUrl) => {
        const resp = await httpPost(apiHarnessUrl(baseUrl, "workflow-with-common"), { n: 5 });
        if (resp.status !== 200) throw new Error(`expected 200, got ${resp.status}`);
        if (bodyRecord(resp.body)["result"] !== 12)
          throw new Error(`expected result 12 (5+7), got ${JSON.stringify(resp.body)}`);
      },
    },
    {
      name: "queue-worker-process-imports-common-offset",
      category: "common-in-unit-types",
      run: async (baseUrl) => {
        const resp = await httpPost(apiHarnessUrl(baseUrl, "queue-with-common"), { n: 3 });
        if (resp.status !== 200) throw new Error(`expected 200, got ${resp.status}`);
        const runId = bodyRecord(resp.body)["runId"];
        if (typeof runId !== "string" || runId.length === 0)
          throw new Error(`expected non-empty runId`);
      },
    },

    // ── sdk-via-common: api → common → sdk ───────────────────────────────────
    {
      name: "actor-via-common-bridge",
      category: "sdk-via-common",
      run: async (baseUrl) => {
        const actorId = `common-sdk-${runTag}`;
        const resp = await httpPost(apiHarnessUrl(baseUrl, "actor-via-common"), { actorId, by: 2 });
        if (resp.status !== 200) throw new Error(`expected 200, got ${resp.status}`);
        if (bodyRecord(resp.body)["count"] !== 2)
          throw new Error(`expected count 2, got ${JSON.stringify(resp.body)}`);
      },
    },
    {
      name: "workflow-via-common-bridge",
      category: "sdk-via-common",
      run: async (baseUrl) => {
        const resp = await httpPost(apiHarnessUrl(baseUrl, "workflow-via-common"), { value: "nested-sdk" });
        if (resp.status !== 200) throw new Error(`expected 200, got ${resp.status}`);
        if (bodyRecord(resp.body)["echoed"] !== "nested-sdk")
          throw new Error(`echo mismatch: ${JSON.stringify(resp.body)}`);
      },
    },
    {
      name: "queue-via-common-bridge",
      category: "sdk-via-common",
      run: async (baseUrl) => {
        const resp = await httpPost(apiHarnessUrl(baseUrl, "queue-via-common"), { data: { viaCommon: true } });
        if (resp.status !== 200) throw new Error(`expected 200, got ${resp.status}`);
        const runId = bodyRecord(resp.body)["runId"];
        if (typeof runId !== "string" || runId.length === 0)
          throw new Error(`expected non-empty runId`);
      },
    },
    {
      name: "full-sdk-chain-via-common",
      category: "sdk-via-common",
      run: async (baseUrl) => {
        const actorId = `common-chain-${runTag}`;
        const resp = await httpPost(apiHarnessUrl(baseUrl, "all-via-common"), { actorId });
        if (resp.status !== 200) throw new Error(`expected 200, got ${resp.status}`);
        const b = bodyRecord(resp.body);
        const actor = b["actor"] as Record<string, unknown> | undefined;
        const workflow = b["workflow"] as Record<string, unknown> | undefined;
        const queue = b["queue"] as Record<string, unknown> | undefined;
        if (actor?.["count"] !== 1) throw new Error(`actor count: ${JSON.stringify(b)}`);
        if (workflow?.["echoed"] !== "chain") throw new Error(`workflow echo: ${JSON.stringify(b)}`);
        const runId = queue?.["runId"];
        if (typeof runId !== "string" || runId.length === 0)
          throw new Error(`queue runId: ${JSON.stringify(b)}`);
      },
    },
  ];
}

async function runTest(baseUrl: string, test: CommonTestDef): Promise<TestResult> {
  const label = `${test.category}: ${test.name}`;
  if (test.skip) {
    return { name: label, pass: true, detail: `SKIPPED: ${test.skip}` };
  }
  try {
    await test.run(baseUrl);
    return { name: label, pass: true };
  } catch (e) {
    return { name: label, pass: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function buildReport(results: TestResult[]) {
  const total = results.length;
  const skipped = results.filter((r) => r.pass && r.detail?.startsWith("SKIPPED:")).length;
  const passed = results.filter((r) => r.pass).length - skipped;
  const failed = total - passed - skipped;

  const sectionsMap: Record<string, TestResult[]> = {};
  for (const r of results) {
    const cat = r.name.split(":")[0]?.trim() ?? "unknown";
    (sectionsMap[cat] ??= []).push(r);
  }

  const sectionSummaries: Record<string, unknown> = {};
  const sectionDetails: Record<string, unknown> = {};
  const flatTests: Array<{ name: string; pass: boolean }> = [];

  for (const cat of Object.keys(sectionsMap).sort()) {
    const catTests = sectionsMap[cat] ?? [];
    const catPassed = catTests.filter((t) => t.pass).length;
    const catFailed = catTests.length - catPassed;
    sectionSummaries[cat] = { pass: catFailed === 0, passed: catPassed, failed: catFailed, total: catTests.length };
    sectionDetails[cat] = {
      pass: catFailed === 0,
      tests: catTests.map((t) => ({
        name: t.name,
        pass: t.pass,
        ...(t.detail ? { detail: t.detail } : {}),
        ...(t.error ? { error: t.error } : {}),
      })),
    };
    for (const t of catTests) flatTests.push({ name: t.name, pass: t.pass });
  }

  return {
    summary: {
      healthy: failed === 0,
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

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const baseUrl = getBaseUrl(req);
  const results: TestResult[] = [];
  for (const test of allTests()) {
    console.log(`  common: ${test.category}: ${test.name} …`);
    results.push(await runTest(baseUrl, test));
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(buildReport(results), null, 2));
}
