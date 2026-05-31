/**
 * `standardwebhooks` npm package test runner (`test.runtime.api.standardwebhooks`).
 * No public npm subpaths — root import only.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { Webhook } from "standardwebhooks";
import {
  handleSuiteRequest,
  runSuiteTests,
  type SuiteResponseBody,
  type SuiteTest,
} from "../../lib/suite-harness.js";

const TESTS: SuiteTest[] = [
  {
    name: "Webhook: sign + verify round-trip",
    run: async () => {
      const secret = Buffer.from("whsec_test").toString("base64");
      const wh = new Webhook(secret);
      const payload = JSON.stringify({ ok: true });
      const msgId = "msg_test_1";
      const ts = new Date();
      const signature = wh.sign(msgId, ts, payload);
      const verified = wh.verify(payload, {
        "webhook-id": msgId,
        "webhook-timestamp": Math.floor(ts.getTime() / 1000).toString(),
        "webhook-signature": signature,
      }) as { ok?: boolean };
      if (verified?.ok !== true) throw new Error(JSON.stringify(verified));
    },
  },
];

export type RequestBody = never;
export type ResponseBody = SuiteResponseBody;
export type QueryParams = never;

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await handleSuiteRequest(req, res, "standardwebhooks", () => runSuiteTests(TESTS));
}
