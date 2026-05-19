/**
 * Formidable library test runner (`test.runtime.api.formidable`).
 *
 * Exercises every seeded harness unit under `formidable/units/` via HTTP POST.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { runFormidableChecks } from "./checks.js";
import { buildSummary, type GroupedTests, type TestResult } from "./lib/test-harness.js";

export type RequestBody = never;
export type ResponseBody = {
  summary: ReturnType<typeof buildSummary>;
  sections: Record<string, GroupedTests>;
  tests: TestResult[];
};
export type QueryParams = never;

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const host = req.headers.host ?? "localhost";
  const baseUrl = `http://${host}`;

  const formidable = await runFormidableChecks(baseUrl);
  const sections: Record<string, GroupedTests> = { formidable };
  const summary = buildSummary(sections);

  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(
    JSON.stringify({
      summary,
      sections,
      tests: formidable.tests,
    } satisfies ResponseBody),
  );
}
