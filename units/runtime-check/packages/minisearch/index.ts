/**
 * `minisearch` npm package test runner (`test.runtime.api.minisearch`).
 */

import "./npm-shim-imports.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import MiniSearch from "minisearch";
import SearchableMap from "minisearch/SearchableMap";
import {
  handleSuiteRequest,
  runSuiteTests,
  type SuiteResponseBody,
  type SuiteTest,
} from "../../lib/suite-harness.js";

const TESTS: SuiteTest[] = [
  {
    name: "MiniSearch: index and search",
    run: async () => {
      const index = new MiniSearch({ fields: ["title"], storeFields: ["title"] });
      index.addAll([
        { id: 1, title: "hello world" },
        { id: 2, title: "goodbye" },
      ]);
      const results = index.search("hello");
      if (results.length !== 1 || results[0]?.id !== 1) throw new Error(JSON.stringify(results));
    },
  },
  {
    name: "minisearch/SearchableMap: subpath export",
    run: async () => {
      const map = new SearchableMap<number>();
      map.set("a", 1);
      if (map.get("a") !== 1) throw new Error(String(map.get("a")));
    },
  },
];

export type RequestBody = never;
export type ResponseBody = SuiteResponseBody;
export type QueryParams = never;

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await handleSuiteRequest(req, res, "minisearch", () => runSuiteTests(TESTS));
}
