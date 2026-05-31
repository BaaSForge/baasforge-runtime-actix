/**
 * `fuse.js` npm package test runner (`test.runtime.api.fuse-js`).
 */

import "./npm-shim-imports.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import Fuse from "fuse.js";
import FuseBasic from "fuse.js/basic";
import {
  handleSuiteRequest,
  runSuiteTests,
  type SuiteResponseBody,
  type SuiteTest,
} from "../../lib/suite-harness.js";

const items = [
  { name: "Alpha", email: "a@example.com" },
  { name: "Beta", email: "b@example.com" },
];

const TESTS: SuiteTest[] = [
  {
    name: "Fuse: fuzzy search (default import)",
    run: async () => {
      const fuse = new Fuse(items, { keys: ["name", "email"], threshold: 0.4 });
      const results = fuse.search("alph");
      if (results.length === 0 || results[0]?.item.name !== "Alpha") {
        throw new Error(JSON.stringify(results));
      }
    },
  },
  {
    name: "fuse.js/basic: subpath export",
    run: async () => {
      const fuse = new FuseBasic(items, { keys: ["name"] });
      const results = fuse.search("beta");
      if (results.length === 0 || results[0]?.item.name !== "Beta") {
        throw new Error(JSON.stringify(results));
      }
    },
  },
];

export type RequestBody = never;
export type ResponseBody = SuiteResponseBody;
export type QueryParams = never;

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await handleSuiteRequest(req, res, "fuse.js", () => runSuiteTests(TESTS));
}
