/**
 * `bcryptjs` npm package test runner (`test.runtime.api.bcryptjs`).
 * No public npm subpaths — root import only.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import bcrypt from "bcryptjs";
import {
  handleSuiteRequest,
  runSuiteTests,
  type SuiteResponseBody,
  type SuiteTest,
} from "../../lib/suite-harness.js";

const TESTS: SuiteTest[] = [
  {
    name: "hash + compare: password round-trip",
    run: async () => {
      const hash = await bcrypt.hash("secret-pass", 4);
      if (typeof hash !== "string" || hash.length < 10) throw new Error(hash);
      const valid = await bcrypt.compare("secret-pass", hash);
      if (!valid) throw new Error("compare returned false");
      const invalid = await bcrypt.compare("wrong", hash);
      if (invalid) throw new Error("compare should reject wrong password");
    },
  },
  {
    name: "genSalt + hashSync + compareSync: sync API",
    run: async () => {
      const salt = bcrypt.genSaltSync(4);
      const hash = bcrypt.hashSync("sync-pass", salt);
      if (!bcrypt.compareSync("sync-pass", hash)) throw new Error("sync compare failed");
    },
  },
];

export type RequestBody = never;
export type ResponseBody = SuiteResponseBody;
export type QueryParams = never;

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await handleSuiteRequest(req, res, "bcryptjs", () => runSuiteTests(TESTS));
}
