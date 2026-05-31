/**
 * `fflate` npm package test runner (`test.runtime.api.fflate`).
 */

import "./npm-shim-imports.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { gzipSync, gunzipSync, strToU8, strFromU8 } from "fflate";
import { gzipSync as gzipSyncBrowser } from "fflate/browser";
import {
  handleSuiteRequest,
  runSuiteTests,
  type SuiteResponseBody,
  type SuiteTest,
} from "../../lib/suite-harness.js";

const TESTS: SuiteTest[] = [
  {
    name: "gzipSync/gunzipSync: text round-trip",
    run: async () => {
      const plain = strToU8('{"ok":true}');
      const compressed = gzipSync(plain);
      const restored = gunzipSync(compressed);
      if (strFromU8(restored) !== '{"ok":true}') throw new Error(strFromU8(restored));
    },
  },
  {
    name: "fflate/browser: gzipSync export (subpath shim)",
    run: async () => {
      if (typeof gzipSyncBrowser !== "function") throw new Error(typeof gzipSyncBrowser);
    },
  },
];

export type RequestBody = never;
export type ResponseBody = SuiteResponseBody;
export type QueryParams = never;

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await handleSuiteRequest(req, res, "fflate", () => runSuiteTests(TESTS));
}
