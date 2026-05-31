/**
 * `lodash-es` npm package test runner (`test.runtime.api.lodash-es`).
 */

import "./npm-shim-imports.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { groupBy, orderBy, uniqBy } from "lodash-es";
import groupBySubpath from "lodash-es/groupBy";
import {
  handleSuiteRequest,
  runSuiteTests,
  type SuiteResponseBody,
  type SuiteTest,
} from "../../lib/suite-harness.js";

const items = [
  { id: 1, category: "a" },
  { id: 2, category: "b" },
  { id: 3, category: "a" },
];

const TESTS: SuiteTest[] = [
  {
    name: "groupBy: root barrel import",
    run: async () => {
      const grouped = groupBy(items, "category");
      if ((grouped["a"]?.length ?? 0) !== 2) throw new Error(JSON.stringify(grouped));
      if ((grouped["b"]?.length ?? 0) !== 1) throw new Error(JSON.stringify(grouped));
    },
  },
  {
    name: "groupBy: subpath import",
    run: async () => {
      const grouped = groupBySubpath(items, "category");
      if ((grouped["a"]?.length ?? 0) !== 2) throw new Error(JSON.stringify(grouped));
    },
  },
  {
    name: "orderBy: multi-key sort",
    run: async () => {
      const rows = [
        { status: "b", n: 2 },
        { status: "a", n: 1 },
        { status: "a", n: 3 },
      ];
      const sorted = orderBy(rows, ["status", "n"], ["asc", "asc"]);
      if (sorted[0]?.n !== 1 || sorted[2]?.n !== 2) throw new Error(JSON.stringify(sorted));
    },
  },
  {
    name: "uniqBy: dedupe by field",
    run: async () => {
      const dupes = [
        { id: 1, v: "x" },
        { id: 1, v: "y" },
        { id: 2, v: "z" },
      ];
      const out = uniqBy(dupes, "id");
      if (out.length !== 2) throw new Error(JSON.stringify(out));
    },
  },
];

export type RequestBody = never;
export type ResponseBody = SuiteResponseBody;
export type QueryParams = never;

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await handleSuiteRequest(req, res, "lodash-es", () => runSuiteTests(TESTS));
}
