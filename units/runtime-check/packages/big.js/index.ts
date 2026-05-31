/**
 * `big.js` npm package test runner (`test.runtime.api.big.js`).
 * No public npm subpaths — root import only (`big.js/big.js` is an alias).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import Big from "big.js";
import {
  handleSuiteRequest,
  runSuiteTests,
  type SuiteResponseBody,
  type SuiteTest,
} from "../../lib/suite-harness.js";

const TESTS: SuiteTest[] = [
  {
    name: "plus: float-safe 0.1 + 0.2",
    run: async () => {
      const sum = Big(0.1).plus(0.2).toFixed(1);
      if (sum !== "0.3") throw new Error(sum);
    },
  },
  {
    name: "default export: constructor",
    run: async () => {
      const v = new Big("123.45").times("0.1").toFixed(4);
      if (v !== "12.3450") throw new Error(v);
    },
  },
];

export type RequestBody = never;
export type ResponseBody = SuiteResponseBody;
export type QueryParams = never;

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await handleSuiteRequest(req, res, "big.js", () => runSuiteTests(TESTS));
}
