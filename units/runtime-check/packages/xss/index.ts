/**
 * `xss` npm package test runner (`test.runtime.api.xss`).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import xss from "xss";
import {
  handleSuiteRequest,
  runSuiteTests,
  type SuiteResponseBody,
  type SuiteTest,
} from "../../lib/suite-harness.js";

const TESTS: SuiteTest[] = [
  {
    name: "xss: strips script tags",
    run: async () => {
      const safe = xss('<p>ok</p><script>alert(1)</script>');
      if (safe.includes("<script")) throw new Error(safe);
      if (!safe.includes("<p>ok</p>")) throw new Error(safe);
    },
  },
  {
    name: "xss: whitelist option",
    run: async () => {
      const safe = xss('<b>bold</b><img onerror=alert(1) src=x>', {
        whiteList: { b: [] },
      });
      if (!safe.includes("<b>")) throw new Error(safe);
      if (safe.includes("<img")) throw new Error(safe);
    },
  },
];

export type RequestBody = never;
export type ResponseBody = SuiteResponseBody;
export type QueryParams = never;

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await handleSuiteRequest(req, res, "xss", () => runSuiteTests(TESTS));
}
