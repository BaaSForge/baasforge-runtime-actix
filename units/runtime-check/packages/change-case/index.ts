/**
 * `change-case` npm package test runner (`test.runtime.api.change-case`).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { camelCase, kebabCase, snakeCase } from "change-case";
import { camelCase as camelCaseKeys } from "change-case/keys";
import {
  handleSuiteRequest,
  runSuiteTests,
  type SuiteResponseBody,
  type SuiteTest,
} from "../../lib/suite-harness.js";

const TESTS: SuiteTest[] = [
  {
    name: "snakeCase: camelCase input",
    run: async () => {
      if (snakeCase("helloWorld") !== "hello_world") {
        throw new Error(snakeCase("helloWorld"));
      }
    },
  },
  {
    name: "camelCase: snake_case input",
    run: async () => {
      if (camelCase("hello_world") !== "helloWorld") {
        throw new Error(camelCase("hello_world"));
      }
    },
  },
  {
    name: "kebabCase: PascalCase input",
    run: async () => {
      if (kebabCase("HelloWorld") !== "hello-world") {
        throw new Error(kebabCase("HelloWorld"));
      }
    },
  },
  {
    name: "camelCase (keys): object key rename",
    run: async () => {
      const out = camelCaseKeys({ user_id: 1, first_name: "a" }) as Record<string, unknown>;
      if (out["userId"] !== 1) throw new Error(JSON.stringify(out));
      if (out["firstName"] !== "a") throw new Error(JSON.stringify(out));
    },
  },
];

export type RequestBody = never;
export type ResponseBody = SuiteResponseBody;
export type QueryParams = never;

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await handleSuiteRequest(req, res, "change-case", () => runSuiteTests(TESTS));
}
