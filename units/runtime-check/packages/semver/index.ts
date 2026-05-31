/**
 * `semver` npm package test runner (`test.runtime.api.semver`).
 * No public subpaths worth bundling — root covers the API.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import semver from "semver";
import {
  handleSuiteRequest,
  runSuiteTests,
  type SuiteResponseBody,
  type SuiteTest,
} from "../../lib/suite-harness.js";

const TESTS: SuiteTest[] = [
  {
    name: "gt: numeric version compare",
    run: async () => {
      if (!semver.gt("1.10.0", "1.9.0")) throw new Error("expected 1.10.0 > 1.9.0");
    },
  },
  {
    name: "satisfies: range",
    run: async () => {
      if (!semver.satisfies("2.3.1", ">=2.0.0 <3.0.0")) {
        throw new Error("expected 2.3.1 to satisfy range");
      }
    },
  },
  {
    name: "coerce: strips prefix",
    run: async () => {
      const coerced = semver.coerce("v2.3.1-beta");
      if (coerced?.version !== "2.3.1") throw new Error(JSON.stringify(coerced));
    },
  },
  {
    name: "valid: rejects invalid",
    run: async () => {
      if (semver.valid("not-a-version") !== null) throw new Error("expected null");
    },
  },
];

export type RequestBody = never;
export type ResponseBody = SuiteResponseBody;
export type QueryParams = never;

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await handleSuiteRequest(req, res, "semver", () => runSuiteTests(TESTS));
}
