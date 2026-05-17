/**
 * Common suite test runner (`test.common.api.index`).
 *
 * test.sh triggers this API unit once; handleRequest runs a small set of
 * infrastructure demos (harness ping, stage isolation, cross-unit SDK, skip).
 * Add real common-unit tests here as the runtime is implemented.
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

function allTests(): CommonTestDef[] {
  const runTag = testRunTag();

  return [
    {
      name: "harness-ping-returns-ok",
      category: "harness",
      run: async (baseUrl) => {
        const resp = await httpGet(apiHarnessUrl(baseUrl, "ping"));
        if (resp.status !== 200) throw new Error(`expected 200, got ${resp.status}`);
        if ((resp.body as Record<string, unknown>)["ok"] !== true)
          throw new Error(`expected ok:true, got ${JSON.stringify(resp.body)}`);
      },
    },
    {
      name: "production-runtime-scope",
      category: "isolation",
      run: async (baseUrl) => {
        const resp = await httpGet(apiHarnessUrl(baseUrl, "runtime-scope"));
        if (resp.status !== 200) throw new Error(`expected 200, got ${resp.status}`);
        if ((resp.body as Record<string, unknown>)["scope"] !== "production")
          throw new Error(`expected production scope`);
      },
    },
    {
      name: "stage-a-runtime-scope",
      category: "isolation",
      run: async (baseUrl) => {
        const resp = await httpGet(apiHarnessStageUrl(baseUrl, "runtime-scope", STAGE_RUNTIME_ID));
        if (resp.status !== 200) throw new Error(`expected 200, got ${resp.status}`);
        if ((resp.body as Record<string, unknown>)["scope"] !== "stage-a")
          throw new Error(`expected stage-a scope`);
      },
    },
    {
      name: "stage-b-runtime-scope",
      category: "isolation",
      run: async (baseUrl) => {
        const resp = await httpGet(apiHarnessStageUrl(baseUrl, "runtime-scope", STAGE_B_RUNTIME_ID));
        if (resp.status !== 200) throw new Error(`expected 200, got ${resp.status}`);
        if ((resp.body as Record<string, unknown>)["scope"] !== "stage-b")
          throw new Error(`expected stage-b scope`);
      },
    },
    {
      name: "call-actor-sync",
      category: "cross-unit",
      run: async (baseUrl) => {
        const actorId = `common-${runTag}`;
        const resp = await httpPost(apiHarnessUrl(baseUrl, "call-actor-sync"), {
          actorId,
          handler: "increment",
          by: 1,
        });
        if (resp.status !== 200) throw new Error(`expected 200, got ${resp.status}`);
        if ((resp.body as Record<string, unknown>)["count"] !== 1)
          throw new Error(`expected count 1, got ${JSON.stringify(resp.body)}`);
      },
    },
    {
      name: "call-workflow",
      category: "cross-unit",
      run: async (baseUrl) => {
        const resp = await httpPost(apiHarnessUrl(baseUrl, "call-workflow"), { value: "ping" });
        if (resp.status !== 200) throw new Error(`expected 200, got ${resp.status}`);
        if ((resp.body as Record<string, unknown>)["echoed"] !== "ping")
          throw new Error(`workflow echo mismatch: ${JSON.stringify(resp.body)}`);
      },
    },
    {
      name: "enqueue-worker",
      category: "cross-unit",
      run: async (baseUrl) => {
        const resp = await httpPost(apiHarnessUrl(baseUrl, "enqueue-worker"), { data: { probe: true } });
        if (resp.status !== 200) throw new Error(`expected 200, got ${resp.status}`);
        const runId = (resp.body as Record<string, unknown>)["runId"];
        if (typeof runId !== "string" || runId.length === 0)
          throw new Error(`expected non-empty runId`);
      },
    },
    {
      name: "native-common-unit",
      category: "future",
      skip: "common unit runtime not implemented — remove skip and implement when ready",
      run: async () => {},
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
