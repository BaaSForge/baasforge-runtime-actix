/**
 * `pluralize` npm package test runner (`test.runtime.api.pluralize`).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import pluralize from "pluralize";
import {
  handleSuiteRequest,
  runSuiteTests,
  type SuiteResponseBody,
  type SuiteTest,
} from "../../lib/suite-harness.js";

const TESTS: SuiteTest[] = [
  {
    name: "pluralize: count selects form",
    run: async () => {
      if (pluralize("item", 1) !== "item") throw new Error(pluralize("item", 1));
      if (pluralize("item", 2) !== "items") throw new Error(pluralize("item", 2));
    },
  },
  {
    name: "pluralize: irregular",
    run: async () => {
      if (pluralize("person", 3) !== "people") throw new Error(pluralize("person", 3));
    },
  },
  {
    name: "pluralize.isPlural",
    run: async () => {
      if (!pluralize.isPlural("teeth")) throw new Error("expected teeth to be plural");
    },
  },
];

export type RequestBody = never;
export type ResponseBody = SuiteResponseBody;
export type QueryParams = never;

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await handleSuiteRequest(req, res, "pluralize", () => runSuiteTests(TESTS));
}
