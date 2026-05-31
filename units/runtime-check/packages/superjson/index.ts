/**
 * `superjson` npm package test runner (`test.runtime.api.superjson`).
 * No public npm subpaths — root import only.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import superjson from "superjson";
import {
  handleSuiteRequest,
  runSuiteTests,
  type SuiteResponseBody,
  type SuiteTest,
} from "../../lib/suite-harness.js";

const TESTS: SuiteTest[] = [
  {
    name: "stringify/parse: Date",
    run: async () => {
      const d = new Date("2026-01-15T12:00:00.000Z");
      const restored = superjson.parse(superjson.stringify({ at: d })) as { at: Date };
      if (!(restored.at instanceof Date)) throw new Error(String(restored.at));
      if (restored.at.toISOString() !== d.toISOString()) throw new Error(restored.at.toISOString());
    },
  },
  {
    name: "stringify/parse: Map and Set",
    run: async () => {
      const payload = { m: new Map([["a", 1]]), s: new Set(["x"]) };
      const restored = superjson.parse(superjson.stringify(payload)) as {
        m: Map<string, number>;
        s: Set<string>;
      };
      if (!(restored.m instanceof Map) || restored.m.get("a") !== 1) {
        throw new Error(JSON.stringify(restored.m));
      }
      if (!(restored.s instanceof Set) || !restored.s.has("x")) {
        throw new Error(JSON.stringify(restored.s));
      }
    },
  },
];

export type RequestBody = never;
export type ResponseBody = SuiteResponseBody;
export type QueryParams = never;

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await handleSuiteRequest(req, res, "superjson", () => runSuiteTests(TESTS));
}
