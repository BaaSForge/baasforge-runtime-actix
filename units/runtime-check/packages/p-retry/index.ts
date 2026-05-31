/**
 * `p-retry` npm package test runner (`test.runtime.api.p-retry`).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import pRetry, { AbortError } from "p-retry";
import {
  handleSuiteRequest,
  runSuiteTests,
  type SuiteResponseBody,
  type SuiteTest,
} from "../../lib/suite-harness.js";

const TESTS: SuiteTest[] = [
  {
    name: "pRetry: succeeds after transient failure",
    run: async () => {
      let attempts = 0;
      const result = await pRetry(
        async () => {
          attempts += 1;
          if (attempts < 2) throw new Error("transient");
          return "ok";
        },
        { retries: 3, minTimeout: 0 },
      );
      if (result !== "ok" || attempts !== 2) {
        throw new Error(`result=${result} attempts=${attempts}`);
      }
    },
  },
  {
    name: "AbortError: exported",
    run: async () => {
      if (typeof AbortError !== "function") throw new Error("missing AbortError");
      const err = new AbortError("stop");
      if (!(err instanceof Error) || err.name !== "AbortError") throw new Error(String(err));
    },
  },
];

export type RequestBody = never;
export type ResponseBody = SuiteResponseBody;
export type QueryParams = never;

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await handleSuiteRequest(req, res, "p-retry", () => runSuiteTests(TESTS));
}
