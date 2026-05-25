/**
 * `qs` npm package test runner (`test.runtime.api.qs`).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import qs from "qs";
import * as qsNamed from "qs";
import {
  handleSuiteRequest,
  runSuiteTests,
  type SuiteResponseBody,
  type SuiteTest,
} from "../../lib/suite-harness.js";

const TESTS: SuiteTest[] = [
  {
    name: "parse: basic query string (default import)",
    run: async () => {
      const parsed = qs.parse("a=1&b=2") as Record<string, string>;
      if (parsed["a"] !== "1") throw new Error(JSON.stringify(parsed));
      if (parsed["b"] !== "2") throw new Error(JSON.stringify(parsed));
    },
  },
  {
    name: "parse: basic query string (namespace import)",
    run: async () => {
      if (typeof qsNamed.parse !== "function") {
        throw new Error(`qsNamed.parse is not a function: ${typeof qsNamed.parse}`);
      }
      const parsed = qsNamed.parse("x=9&y=8") as Record<string, string>;
      if (parsed["x"] !== "9") throw new Error(JSON.stringify(parsed));
      if (parsed["y"] !== "8") throw new Error(JSON.stringify(parsed));
    },
  },
];

export type RequestBody = never;
export type ResponseBody = SuiteResponseBody;
export type QueryParams = never;

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await handleSuiteRequest(req, res, "qs", () => runSuiteTests(TESTS));
}
