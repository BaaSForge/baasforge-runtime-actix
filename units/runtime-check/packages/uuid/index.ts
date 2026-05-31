/**
 * `uuid` npm package test runner (`test.runtime.api.uuid`).
 * No public subpaths — named exports from root only.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { validate, v4 as uuidv4, v7 as uuidv7, version } from "uuid";
import {
  handleSuiteRequest,
  runSuiteTests,
  type SuiteResponseBody,
  type SuiteTest,
} from "../../lib/suite-harness.js";

const TESTS: SuiteTest[] = [
  {
    name: "v4: RFC-style uuid",
    run: async () => {
      const id = uuidv4();
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
        throw new Error(id);
      }
    },
  },
  {
    name: "v7: time-ordered uuid",
    run: async () => {
      const id = uuidv7();
      if (!validate(id)) throw new Error(id);
      if (version(id) !== 7) throw new Error(`expected v7, got ${version(id)}`);
    },
  },
  {
    name: "validate: rejects garbage",
    run: async () => {
      if (validate("not-a-uuid")) throw new Error("expected false");
    },
  },
];

export type RequestBody = never;
export type ResponseBody = SuiteResponseBody;
export type QueryParams = never;

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await handleSuiteRequest(req, res, "uuid", () => runSuiteTests(TESTS));
}
