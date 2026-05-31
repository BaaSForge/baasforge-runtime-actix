/**
 * `p-timeout` npm package test runner (`test.runtime.api.p-timeout`).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import pTimeout, { TimeoutError } from "p-timeout";
import {
  handleSuiteRequest,
  runSuiteTests,
  type SuiteResponseBody,
  type SuiteTest,
} from "../../lib/suite-harness.js";

const TESTS: SuiteTest[] = [
  {
    name: "pTimeout: resolves fast promise",
    run: async () => {
      const value = await pTimeout(Promise.resolve(42), { milliseconds: 100 });
      if (value !== 42) throw new Error(String(value));
    },
  },
  {
    name: "pTimeout: rejects slow promise",
    run: async () => {
      const slow = new Promise<number>((resolve) => {
        setTimeout(() => resolve(1), 200);
      });
      let threw = false;
      try {
        await pTimeout(slow, { milliseconds: 20, message: "too slow" });
      } catch (e) {
        threw = e instanceof TimeoutError;
      }
      if (!threw) throw new Error("expected TimeoutError");
    },
  },
];

export type RequestBody = never;
export type ResponseBody = SuiteResponseBody;
export type QueryParams = never;

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await handleSuiteRequest(req, res, "p-timeout", () => runSuiteTests(TESTS));
}
