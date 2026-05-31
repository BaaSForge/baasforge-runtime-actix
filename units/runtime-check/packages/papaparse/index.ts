/**
 * `papaparse` npm package test runner (`test.runtime.api.papaparse`).
 * No public npm subpaths — root import only.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import Papa from "papaparse";
import {
  handleSuiteRequest,
  runSuiteTests,
  type SuiteResponseBody,
  type SuiteTest,
} from "../../lib/suite-harness.js";

const TESTS: SuiteTest[] = [
  {
    name: "parse: header row",
    run: async () => {
      const { data, errors } = Papa.parse<{ name: string; age: string }>("name,age\nAlice,30", {
        header: true,
        skipEmptyLines: true,
      });
      if (errors.length) throw new Error(JSON.stringify(errors));
      if (data[0]?.name !== "Alice" || data[0]?.age !== "30") {
        throw new Error(JSON.stringify(data));
      }
    },
  },
  {
    name: "unparse: rows to CSV",
    run: async () => {
      const csv = Papa.unparse([
        { name: "Bob", age: 25 },
        { name: "Ann", age: 31 },
      ]);
      if (!csv.includes("Bob,25")) throw new Error(csv);
    },
  },
];

export type RequestBody = never;
export type ResponseBody = SuiteResponseBody;
export type QueryParams = never;

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await handleSuiteRequest(req, res, "papaparse", () => runSuiteTests(TESTS));
}
