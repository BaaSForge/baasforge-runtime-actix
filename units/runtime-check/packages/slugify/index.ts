/**
 * `slugify` npm package test runner (`test.runtime.api.slugify`).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import slugify from "slugify";
import {
  handleSuiteRequest,
  runSuiteTests,
  type SuiteResponseBody,
  type SuiteTest,
} from "../../lib/suite-harness.js";

const TESTS: SuiteTest[] = [
  {
    name: "slugify: accented latin",
    run: async () => {
      if (slugify("Héllo Wörld!", { lower: true }) !== "hello-world!") {
        throw new Error(slugify("Héllo Wörld!", { lower: true }));
      }
    },
  },
  {
    name: "slugify: lower and strict",
    run: async () => {
      const out = slugify("Title: 100% Real!", { lower: true, strict: true });
      if (out !== "title-100percent-real") throw new Error(out);
    },
  },
];

export type RequestBody = never;
export type ResponseBody = SuiteResponseBody;
export type QueryParams = never;

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await handleSuiteRequest(req, res, "slugify", () => runSuiteTests(TESTS));
}
