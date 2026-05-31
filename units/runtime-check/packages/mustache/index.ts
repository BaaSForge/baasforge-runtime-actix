/**
 * `mustache` npm package test runner (`test.runtime.api.mustache`).
 * No public npm subpaths — root import only.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import Mustache from "mustache";
import {
  handleSuiteRequest,
  runSuiteTests,
  type SuiteResponseBody,
  type SuiteTest,
} from "../../lib/suite-harness.js";

const TESTS: SuiteTest[] = [
  {
    name: "render: interpolates variables (default import)",
    run: async () => {
      const html = Mustache.render("<p>{{name}}</p>", { name: "Ada" });
      if (html !== "<p>Ada</p>") throw new Error(html);
    },
  },
];

export type RequestBody = never;
export type ResponseBody = SuiteResponseBody;
export type QueryParams = never;

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await handleSuiteRequest(req, res, "mustache", () => runSuiteTests(TESTS));
}
