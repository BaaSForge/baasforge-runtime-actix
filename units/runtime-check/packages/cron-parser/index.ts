/**
 * `cron-parser` npm package test runner (`test.runtime.api.cron-parser`).
 * No public npm subpaths — root import only.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { CronExpressionParser } from "cron-parser";
import {
  handleSuiteRequest,
  runSuiteTests,
  type SuiteResponseBody,
  type SuiteTest,
} from "../../lib/suite-harness.js";

const TESTS: SuiteTest[] = [
  {
    name: "CronExpressionParser.parse: next tick",
    run: async () => {
      const interval = CronExpressionParser.parse("0 */15 9-17 * * 1-5");
      const next = interval.next();
      if (!next || typeof next.toString !== "function") throw new Error("missing next()");
    },
  },
  {
    name: "CronExpressionParser.parse: invalid expression throws",
    run: async () => {
      try {
        CronExpressionParser.parse("not a cron");
        throw new Error("expected parse to throw");
      } catch (e) {
        if (e instanceof Error && e.message === "expected parse to throw") throw e;
      }
    },
  },
];

export type RequestBody = never;
export type ResponseBody = SuiteResponseBody;
export type QueryParams = never;

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await handleSuiteRequest(req, res, "cron-parser", () => runSuiteTests(TESTS));
}
