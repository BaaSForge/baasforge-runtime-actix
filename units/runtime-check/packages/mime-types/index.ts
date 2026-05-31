/**
 * `mime-types` npm package test runner (`test.runtime.api.mime-types`).
 * No public npm subpaths — root import only.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { lookup } from "mime-types";
import * as mimeTypesNamed from "mime-types";
import {
  handleSuiteRequest,
  runSuiteTests,
  type SuiteResponseBody,
  type SuiteTest,
} from "../../lib/suite-harness.js";

const TESTS: SuiteTest[] = [
  {
    name: "lookup: file extension (named import)",
    run: async () => {
      const type = lookup("file.json");
      if (type !== "application/json") throw new Error(JSON.stringify(type));
    },
  },
  {
    name: "lookup: file extension (namespace import)",
    run: async () => {
      if (typeof mimeTypesNamed.lookup !== "function") {
        throw new Error(`mimeTypesNamed.lookup is not a function: ${typeof mimeTypesNamed.lookup}`);
      }
      const type = mimeTypesNamed.lookup("file.png");
      if (type !== "image/png") throw new Error(JSON.stringify(type));
    },
  },
];

export type RequestBody = never;
export type ResponseBody = SuiteResponseBody;
export type QueryParams = never;

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await handleSuiteRequest(req, res, "mime-types", () => runSuiteTests(TESTS));
}
