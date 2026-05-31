/**
 * `escape-html` npm package test runner (`test.runtime.api.escape-html`).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import escapeHtml from "escape-html";
import {
  handleSuiteRequest,
  runSuiteTests,
  type SuiteResponseBody,
  type SuiteTest,
} from "../../lib/suite-harness.js";

const TESTS: SuiteTest[] = [
  {
    name: "escapeHtml: special characters",
    run: async () => {
      const out = escapeHtml(`<&>"'`);
      if (out !== "&lt;&amp;&gt;&quot;&#39;") throw new Error(out);
    },
  },
];

export type RequestBody = never;
export type ResponseBody = SuiteResponseBody;
export type QueryParams = never;

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await handleSuiteRequest(req, res, "escape-html", () => runSuiteTests(TESTS));
}
