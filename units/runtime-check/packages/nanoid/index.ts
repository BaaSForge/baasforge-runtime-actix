/**
 * `nanoid` npm package test runner (`test.runtime.api.nanoid`).
 */

import "./npm-shim-imports.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { customAlphabet, nanoid } from "nanoid";
import { nanoid as nanoidNonSecure } from "nanoid/non-secure";
import {
  handleSuiteRequest,
  runSuiteTests,
  type SuiteResponseBody,
  type SuiteTest,
} from "../../lib/suite-harness.js";

const TESTS: SuiteTest[] = [
  {
    name: "nanoid: default length",
    run: async () => {
      const id = nanoid();
      if (typeof id !== "string" || id.length !== 21) throw new Error(id);
    },
  },
  {
    name: "nanoid: custom length",
    run: async () => {
      const id = nanoid(10);
      if (id.length !== 10) throw new Error(id);
    },
  },
  {
    name: "customAlphabet: numeric",
    run: async () => {
      const digits = customAlphabet("0123456789", 8);
      const id = digits();
      if (!/^\d{8}$/.test(id)) throw new Error(id);
    },
  },
  {
    name: "nanoid/non-secure: generates id",
    run: async () => {
      const id = nanoidNonSecure();
      if (typeof id !== "string" || id.length < 10) throw new Error(id);
    },
  },
];

export type RequestBody = never;
export type ResponseBody = SuiteResponseBody;
export type QueryParams = never;

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await handleSuiteRequest(req, res, "nanoid", () => runSuiteTests(TESTS));
}
