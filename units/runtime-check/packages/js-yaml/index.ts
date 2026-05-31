/**
 * `js-yaml` npm package test runner (`test.runtime.api.js-yaml`).
 * No public npm subpaths — root import only.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import yaml, { load, dump } from "js-yaml";
import {
  handleSuiteRequest,
  runSuiteTests,
  type SuiteResponseBody,
  type SuiteTest,
} from "../../lib/suite-harness.js";

const TESTS: SuiteTest[] = [
  {
    name: "load: default import",
    run: async () => {
      const obj = yaml.load("a: 1\nb: two") as Record<string, unknown>;
      if (obj["a"] !== 1) throw new Error(JSON.stringify(obj));
      if (obj["b"] !== "two") throw new Error(JSON.stringify(obj));
    },
  },
  {
    name: "dump: named import round-trip",
    run: async () => {
      const text = dump({ x: 1, y: "z" });
      const obj = load(text) as Record<string, unknown>;
      if (obj["x"] !== 1 || obj["y"] !== "z") throw new Error(JSON.stringify(obj));
    },
  },
];

export type RequestBody = never;
export type ResponseBody = SuiteResponseBody;
export type QueryParams = never;

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await handleSuiteRequest(req, res, "js-yaml", () => runSuiteTests(TESTS));
}
