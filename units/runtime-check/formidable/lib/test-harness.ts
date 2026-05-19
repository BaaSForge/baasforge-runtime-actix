export const TEST_PROJECT_ID = "00000000-aaaa-bbbb-cccc-000000000010";

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

export function responseText(body: unknown): string {
  return typeof body === "string" ? body : JSON.stringify(body);
}

export function harnessJsonBody(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error(`expected JSON object, got ${responseText(body)}`);
  }
  return body as Record<string, unknown>;
}

export function buildSummary(sections: Record<string, GroupedTests>) {
  let totalTests = 0;
  let totalPassed = 0;
  let totalFailed = 0;
  const sectionSummaries: Record<
    string,
    { pass: boolean; passed: number; failed: number; total: number }
  > = {};

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
