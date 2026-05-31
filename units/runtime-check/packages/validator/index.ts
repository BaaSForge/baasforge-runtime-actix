/**
 * `validator` npm package test runner (`test.runtime.api.validator`).
 */

import "./npm-shim-imports.js"; // registers subpaths for QuickJS shim bundling — add new ones in npm-shim-imports.ts
import type { IncomingMessage, ServerResponse } from "node:http";
import isEmail from "validator/lib/isEmail";
import isUUID from "validator/lib/isUUID";
import validator from "validator";
import {
  handleSuiteRequest,
  runSuiteTests,
  type SuiteResponseBody,
  type SuiteTest,
} from "../../lib/suite-harness.js";

const TESTS: SuiteTest[] = [
  {
    name: "isEmail: valid address (default import)",
    run: async () => {
      if (!validator.isEmail("a@example.com")) {
        throw new Error("expected isEmail to accept a@example.com");
      }
    },
  },
  {
    name: "isEmail: valid address (subpath default import)",
    run: async () => {
      if (!isEmail("a@example.com")) {
        throw new Error("expected subpath isEmail to accept a@example.com");
      }
    },
  },
  {
    name: "isUUID: valid v4 (subpath default import)",
    run: async () => {
      if (!isUUID("550e8400-e29b-41d4-a716-446655440000")) {
        throw new Error("expected subpath isUUID to accept a v4 UUID");
      }
    },
  },
];

export type RequestBody = never;
export type ResponseBody = SuiteResponseBody;
export type QueryParams = never;

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await handleSuiteRequest(req, res, "validator", () => runSuiteTests(TESTS));
}
