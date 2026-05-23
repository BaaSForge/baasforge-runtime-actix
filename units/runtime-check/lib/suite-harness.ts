import type { IncomingMessage, ServerResponse } from "node:http";

export interface TestResult {
  name: string;
  pass: boolean;
  detail?: string;
  error?: string;
}

export interface GroupedTests {
  pass: boolean;
  tests: TestResult[];
}

export interface SuiteSummary {
  healthy: boolean;
  total_tests: number;
  total_passed: number;
  total_failed: number;
  sections: Record<string, { pass: boolean; passed: number; failed: number; total: number }>;
}

export type SuiteResponseBody = {
  summary: SuiteSummary;
  sections: Record<string, GroupedTests>;
  tests: TestResult[];
};

export interface SuiteTest {
  name: string;
  run: () => Promise<string | void>;
}

export function group(tests: TestResult[]): GroupedTests {
  return { pass: tests.every((t) => t.pass), tests };
}

export async function runTestAsync(
  name: string,
  fn: () => Promise<string | void>,
): Promise<TestResult> {
  try {
    const detail = await fn();
    return { name, pass: true, ...(detail ? { detail } : {}) };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { name, pass: false, error: msg };
  }
}

export async function runSuiteTests(tests: SuiteTest[]): Promise<TestResult[]> {
  const results: TestResult[] = [];
  for (const test of tests) {
    results.push(await runTestAsync(test.name, test.run));
  }
  return results;
}

export function buildSummary(sections: Record<string, GroupedTests>): SuiteSummary {
  let totalTests = 0;
  let totalPassed = 0;
  let totalFailed = 0;
  const sectionSummaries: SuiteSummary["sections"] = {};

  for (const [name, sec] of Object.entries(sections)) {
    const passed = sec.tests.filter((t) => t.pass).length;
    const failed = sec.tests.length - passed;
    totalTests += sec.tests.length;
    totalPassed += passed;
    totalFailed += failed;
    sectionSummaries[name] = {
      pass: sec.pass,
      passed,
      failed,
      total: sec.tests.length,
    };
  }

  return {
    healthy: totalFailed === 0,
    total_tests: totalTests,
    total_passed: totalPassed,
    total_failed: totalFailed,
    sections: sectionSummaries,
  };
}

export function sendSuiteResponse(
  res: ServerResponse,
  sectionName: string,
  section: GroupedTests,
): void {
  const sections: Record<string, GroupedTests> = { [sectionName]: section };
  const summary = buildSummary(sections);
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(
    JSON.stringify({
      summary,
      sections,
      tests: section.tests,
    } satisfies SuiteResponseBody),
  );
}

export async function handleSuiteRequest(
  _req: IncomingMessage,
  res: ServerResponse,
  sectionName: string,
  collectTests: () => Promise<TestResult[]>,
): Promise<void> {
  const section = group(await collectTests());
  sendSuiteResponse(res, sectionName, section);
}
