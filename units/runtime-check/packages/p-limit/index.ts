/**
 * `p-limit` npm package test runner (`test.runtime.api.p-limit`).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import pLimit, { limitFunction } from "p-limit";
import {
  handleSuiteRequest,
  runSuiteTests,
  type SuiteResponseBody,
  type SuiteTest,
} from "../../lib/suite-harness.js";

const TESTS: SuiteTest[] = [
  {
    name: "pLimit: caps concurrency",
    run: async () => {
      const limit = pLimit(1);
      let active = 0;
      let maxActive = 0;
      const track = async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 10));
        active -= 1;
        return 1;
      };
      await Promise.all([limit(track), limit(track), limit(track)]);
      if (maxActive !== 1) throw new Error(`maxActive=${maxActive}`);
    },
  },
  {
    name: "limitFunction: exported",
    run: async () => {
      if (typeof limitFunction !== "function") throw new Error("missing limitFunction");
      const limited = limitFunction(async () => "x", { concurrency: 1 });
      const a = await limited();
      if (a !== "x") throw new Error(String(a));
    },
  },
];

export type RequestBody = never;
export type ResponseBody = SuiteResponseBody;
export type QueryParams = never;

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await handleSuiteRequest(req, res, "p-limit", () => runSuiteTests(TESTS));
}
