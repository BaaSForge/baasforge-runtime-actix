/**
 * `cookie` npm package test runner (`test.runtime.api.cookie`).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { parse } from "cookie";
import * as cookieNamed from "cookie";
import {
  handleSuiteRequest,
  runSuiteTests,
  type SuiteResponseBody,
  type SuiteTest,
} from "../../lib/suite-harness.js";

const TESTS: SuiteTest[] = [
  {
    name: "parse: basic cookie header (named import)",
    run: async () => {
      const parsed = parse("session=abc; theme=dark");
      if (parsed["session"] !== "abc") throw new Error(JSON.stringify(parsed));
      if (parsed["theme"] !== "dark") throw new Error(JSON.stringify(parsed));
    },
  },
  {
    name: "parse: basic cookie header (namespace import)",
    run: async () => {
      if (typeof cookieNamed.parse !== "function") {
        throw new Error(`cookieNamed.parse is not a function: ${typeof cookieNamed.parse}`);
      }
      const parsed = cookieNamed.parse("x=9; y=8");
      if (parsed["x"] !== "9") throw new Error(JSON.stringify(parsed));
      if (parsed["y"] !== "8") throw new Error(JSON.stringify(parsed));
    },
  },
];

export type RequestBody = never;
export type ResponseBody = SuiteResponseBody;
export type QueryParams = never;

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await handleSuiteRequest(req, res, "cookie", () => runSuiteTests(TESTS));
}
