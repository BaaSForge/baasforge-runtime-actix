/**
 * `luxon` npm package test runner (`test.runtime.api.luxon`).
 * No public npm subpaths — root import only.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { DateTime, Duration } from "luxon";
import {
  handleSuiteRequest,
  runSuiteTests,
  type SuiteResponseBody,
  type SuiteTest,
} from "../../lib/suite-harness.js";

const TESTS: SuiteTest[] = [
  {
    name: "DateTime: format ISO date",
    run: async () => {
      const formatted = DateTime.fromISO("2024-06-15").toFormat("yyyy-MM-dd");
      if (formatted !== "2024-06-15") throw new Error(formatted);
    },
  },
  {
    name: "Duration: from ISO",
    run: async () => {
      const d = Duration.fromISO("P1DT2H");
      if (d.days !== 1 || d.hours !== 2) throw new Error(JSON.stringify(d.toObject()));
    },
  },
];

export type RequestBody = never;
export type ResponseBody = SuiteResponseBody;
export type QueryParams = never;

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await handleSuiteRequest(req, res, "luxon", () => runSuiteTests(TESTS));
}
