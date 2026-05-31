/**
 * `decimal.js` npm package test runner (`test.runtime.api.decimal.js`).
 * No public npm subpaths — root import only (`decimal.js/decimal` is an alias).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import Decimal from "decimal.js";
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
      const sum = new Decimal(0.1).plus(0.2).toString();
      if (sum !== "0.3") throw new Error(sum);
    },
  },
  {
    name: "toDecimalPlaces: bankers rounding",
    run: async () => {
      const rounded = new Decimal(1.005).toDecimalPlaces(2).toString();
      if (rounded !== "1.01") throw new Error(rounded);
    },
  },
];

export type RequestBody = never;
export type ResponseBody = SuiteResponseBody;
export type QueryParams = never;

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await handleSuiteRequest(req, res, "decimal.js", () => runSuiteTests(TESTS));
}
