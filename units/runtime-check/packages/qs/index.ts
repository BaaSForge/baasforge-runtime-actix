/**
 * node:querystring library test runner (`test.runtime.api.qs`).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { parse } from "node:querystring";
import {
  handleSuiteRequest,
  runSuiteTests,
  type SuiteResponseBody,
  type SuiteTest,
} from "../../lib/suite-harness.js";

const TESTS: SuiteTest[] = [
  {
    name: "parse: basic query string",
    run: async () => {
      const parsed = parse("a=1&b=2") as Record<string, string>;
      if (parsed["a"] !== "1") throw new Error(JSON.stringify(parsed));
      if (parsed["b"] !== "2") throw new Error(JSON.stringify(parsed));
    },
  },
];

export type RequestBody = never;
export type ResponseBody = SuiteResponseBody;
export type QueryParams = never;

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await handleSuiteRequest(req, res, "qs", () => runSuiteTests(TESTS));
}
