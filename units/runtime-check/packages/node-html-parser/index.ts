/**
 * `node-html-parser` npm package test runner (`test.runtime.api.node-html-parser`).
 * No public npm subpaths — root import only.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { parse } from "node-html-parser";
import {
  handleSuiteRequest,
  runSuiteTests,
  type SuiteResponseBody,
  type SuiteTest,
} from "../../lib/suite-harness.js";

const TESTS: SuiteTest[] = [
  {
    name: "parse: querySelector reads title (named import)",
    run: async () => {
      const root = parse("<html><title>Hi</title><a href='/x'>link</a></html>");
      if (root.querySelector("title")?.text !== "Hi") throw new Error(root.toString());
      const href = root.querySelector("a")?.getAttribute("href");
      if (href !== "/x") throw new Error(String(href));
    },
  },
];

export type RequestBody = never;
export type ResponseBody = SuiteResponseBody;
export type QueryParams = never;

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await handleSuiteRequest(req, res, "node-html-parser", () => runSuiteTests(TESTS));
}
