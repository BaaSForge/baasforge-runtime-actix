/**
 * `arctic` npm package test runner (`test.runtime.api.arctic`).
 * No public npm subpaths — root import only.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { GitHub, generateCodeVerifier, generateState } from "arctic";
import {
  handleSuiteRequest,
  runSuiteTests,
  type SuiteResponseBody,
  type SuiteTest,
} from "../../lib/suite-harness.js";

const TESTS: SuiteTest[] = [
  {
    name: "GitHub: createAuthorizationURL",
    run: async () => {
      const github = new GitHub("client-id", "client-secret", "https://example.com/callback");
      const state = generateState();
      const url = github.createAuthorizationURL(state, ["user:email"]);
      if (!(url instanceof URL)) throw new Error(String(url));
      if (!url.hostname.includes("github")) throw new Error(url.toString());
    },
  },
  {
    name: "generateState + generateCodeVerifier",
    run: async () => {
      const state = generateState();
      const verifier = generateCodeVerifier();
      if (typeof state !== "string" || state.length < 43) throw new Error(state);
      if (typeof verifier !== "string" || verifier.length < 43) throw new Error(verifier);
    },
  },
];

export type RequestBody = never;
export type ResponseBody = SuiteResponseBody;
export type QueryParams = never;

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await handleSuiteRequest(req, res, "arctic", () => runSuiteTests(TESTS));
}
