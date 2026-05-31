/**
 * `ms` npm package test runner (`test.runtime.api.ms`).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import ms from "ms";
import {
  handleSuiteRequest,
  runSuiteTests,
  type SuiteResponseBody,
  type SuiteTest,
} from "../../lib/suite-harness.js";

const TESTS: SuiteTest[] = [
  {
    name: "parse: duration string",
    run: async () => {
      const sevenDays = ms("7 days");
      if (sevenDays !== 7 * 24 * 60 * 60 * 1000) throw new Error(String(sevenDays));
    },
  },
  {
    name: "format: ms to string",
    run: async () => {
      const label = ms(604800000);
      if (label !== "7d") throw new Error(String(label));
    },
  },
];

export type RequestBody = never;
export type ResponseBody = SuiteResponseBody;
export type QueryParams = never;

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await handleSuiteRequest(req, res, "ms", () => runSuiteTests(TESTS));
}
