/**
 * `zod` npm package test runner (`test.runtime.api.zod`).
 */

import "./npm-shim-imports.js"; // registers subpaths for QuickJS shim bundling — add new ones in npm-shim-imports.ts
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { z as zMini } from "zod/mini";
import {
  handleSuiteRequest,
  runSuiteTests,
  type SuiteResponseBody,
  type SuiteTest,
} from "../../lib/suite-harness.js";

const TESTS: SuiteTest[] = [
  {
    name: "parse: basic object schema (named import)",
    run: async () => {
      const schema = z.object({ a: z.string() });
      const parsed = schema.parse({ a: "1" });
      if (parsed.a !== "1") throw new Error(JSON.stringify(parsed));
    },
  },
  {
    name: "parse: basic string schema (zod/mini subpath)",
    run: async () => {
      const parsed = zMini.string().parse("ok");
      if (parsed !== "ok") throw new Error(JSON.stringify(parsed));
    },
  },
];

export type RequestBody = never;
export type ResponseBody = SuiteResponseBody;
export type QueryParams = never;

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await handleSuiteRequest(req, res, "zod", () => runSuiteTests(TESTS));
}
