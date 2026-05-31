/**
 * `http-errors` npm package test runner (`test.runtime.api.http-errors`).
 * No public npm subpaths — root import only.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import createError from "http-errors";
import {
  handleSuiteRequest,
  runSuiteTests,
  type SuiteResponseBody,
  type SuiteTest,
} from "../../lib/suite-harness.js";

const TESTS: SuiteTest[] = [
  {
    name: "createError: status and message (default import)",
    run: async () => {
      const err = createError(404, "User not found");
      if (err.status !== 404) throw new Error(JSON.stringify(err.status));
      if (err.message !== "User not found") throw new Error(JSON.stringify(err.message));
    },
  },
  {
    name: "createError: forbidden status",
    run: async () => {
      const err = createError(403, "Forbidden");
      if (err.status !== 403) throw new Error(JSON.stringify(err.status));
      if (err.message !== "Forbidden") throw new Error(JSON.stringify(err.message));
    },
  },
];

export type RequestBody = never;
export type ResponseBody = SuiteResponseBody;
export type QueryParams = never;

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.searchParams.get("mode") === "throw") {
    throw createError(403, "Forbidden");
  }
  await handleSuiteRequest(req, res, "http-errors", () => runSuiteTests(TESTS));
}
