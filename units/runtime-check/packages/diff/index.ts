/**
 * `diff` npm package test runner (`test.runtime.api.diff`).
 * No public npm subpaths — root import only (`./lib/*` are internals).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { createPatch, diffWords } from "diff";
import {
  handleSuiteRequest,
  runSuiteTests,
  type SuiteResponseBody,
  type SuiteTest,
} from "../../lib/suite-harness.js";

const TESTS: SuiteTest[] = [
  {
    name: "createPatch: unified diff header",
    run: async () => {
      const patch = createPatch("f.txt", "hello", "hello world");
      if (!patch.includes("@@")) throw new Error(patch);
    },
  },
  {
    name: "diffWords: added/removed segments",
    run: async () => {
      const parts = diffWords("a b", "a c");
      const hasRemoved = parts.some((p) => p.removed);
      const hasAdded = parts.some((p) => p.added);
      if (!hasRemoved || !hasAdded) throw new Error(JSON.stringify(parts));
    },
  },
];

export type RequestBody = never;
export type ResponseBody = SuiteResponseBody;
export type QueryParams = never;

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await handleSuiteRequest(req, res, "diff", () => runSuiteTests(TESTS));
}
