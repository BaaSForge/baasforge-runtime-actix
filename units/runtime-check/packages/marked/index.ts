/**
 * `marked` npm package test runner (`test.runtime.api.marked`).
 * No public npm subpaths — root import only (skip CLI `marked/bin/marked`).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { marked } from "marked";
import {
  handleSuiteRequest,
  runSuiteTests,
  type SuiteResponseBody,
  type SuiteTest,
} from "../../lib/suite-harness.js";

const TESTS: SuiteTest[] = [
  {
    name: "marked: parses heading to HTML (named import)",
    run: async () => {
      const html = await marked("# Hi");
      if (!html.includes("<h1")) throw new Error(html);
      if (!html.includes("Hi")) throw new Error(html);
    },
  },
];

export type RequestBody = never;
export type ResponseBody = SuiteResponseBody;
export type QueryParams = never;

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await handleSuiteRequest(req, res, "marked", () => runSuiteTests(TESTS));
}
