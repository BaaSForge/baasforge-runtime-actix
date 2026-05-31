/**
 * `oauth4webapi` npm package test runner (`test.runtime.api.oauth-four-webapi`).
 * No public npm subpaths — root import only.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import * as oauth from "oauth4webapi";
import {
  handleSuiteRequest,
  runSuiteTests,
  type SuiteResponseBody,
  type SuiteTest,
} from "../../lib/suite-harness.js";

const TESTS: SuiteTest[] = [
  {
    name: "generateRandomCodeVerifier + calculatePKCECodeChallenge",
    run: async () => {
      const verifier = oauth.generateRandomCodeVerifier();
      if (typeof verifier !== "string" || verifier.length < 43) {
        throw new Error(`unexpected verifier: ${verifier}`);
      }
      const challenge = await oauth.calculatePKCECodeChallenge(verifier);
      if (typeof challenge !== "string" || challenge.length < 43) {
        throw new Error(`unexpected challenge: ${challenge}`);
      }
    },
  },
  {
    name: "generateRandomState + generateRandomNonce",
    run: async () => {
      const state = oauth.generateRandomState();
      const nonce = oauth.generateRandomNonce();
      if (typeof state !== "string" || state.length < 43) throw new Error(String(state));
      if (typeof nonce !== "string" || nonce.length < 43) throw new Error(String(nonce));
    },
  },
];

export type RequestBody = never;
export type ResponseBody = SuiteResponseBody;
export type QueryParams = never;

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await handleSuiteRequest(req, res, "oauth4webapi", () => runSuiteTests(TESTS));
}
