/**
 * `qrcode` npm package test runner (`test.runtime.api.qrcode`).
 * No public npm subpaths — root import only.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import QRCode from "qrcode";
import {
  handleSuiteRequest,
  runSuiteTests,
  type SuiteResponseBody,
  type SuiteTest,
} from "../../lib/suite-harness.js";

const TESTS: SuiteTest[] = [
  {
    name: "toString: SVG output",
    run: async () => {
      const svg = await QRCode.toString("https://example.com", { type: "svg" });
      if (!svg.includes("<svg")) throw new Error(svg.slice(0, 80));
    },
  },
];

export type RequestBody = never;
export type ResponseBody = SuiteResponseBody;
export type QueryParams = never;

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await handleSuiteRequest(req, res, "qrcode", () => runSuiteTests(TESTS));
}
