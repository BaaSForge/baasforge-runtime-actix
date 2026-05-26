/**
 * `statuses` npm package test runner (`test.runtime.api.statuses`).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import statuses from "statuses";
import * as statusesNamed from "statuses";
import {
  handleSuiteRequest,
  runSuiteTests,
  type SuiteResponseBody,
  type SuiteTest,
} from "../../lib/suite-harness.js";

const TESTS: SuiteTest[] = [
  {
    name: "lookup: numeric code (default import)",
    run: async () => {
      const msg = statuses(404);
      if (msg !== "Not Found") throw new Error(JSON.stringify(msg));
    },
  },
  {
    name: "lookup: numeric code (namespace default)",
    run: async () => {
      const fn = statusesNamed.default;
      if (typeof fn !== "function") {
        throw new Error(`statusesNamed.default is not a function: ${typeof fn}`);
      }
      const msg = fn(422);
      if (msg !== "Unprocessable Entity") throw new Error(JSON.stringify(msg));
    },
  },
  {
    name: "flags: redirect and empty",
    run: async () => {
      if (!statuses.redirect[301]) throw new Error("expected 301 redirect");
      if (!statuses.empty[204]) throw new Error("expected 204 empty");
    },
  },
];

export type RequestBody = never;
export type ResponseBody = SuiteResponseBody;
export type QueryParams = never;

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await handleSuiteRequest(req, res, "statuses", () => runSuiteTests(TESTS));
}
