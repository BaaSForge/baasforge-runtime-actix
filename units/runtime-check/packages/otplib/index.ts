/**
 * `otplib` npm package test runner (`test.runtime.api.otplib`).
 */

import "./npm-shim-imports.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { generate, generateSecret, verify } from "otplib";
import { generate as generateFunctional } from "otplib/functional";
import { OTP } from "otplib/class";
import {
  handleSuiteRequest,
  runSuiteTests,
  type SuiteResponseBody,
  type SuiteTest,
} from "../../lib/suite-harness.js";

const TESTS: SuiteTest[] = [
  {
    name: "generateSecret + generate + verify: root import",
    run: async () => {
      const secret = generateSecret();
      const token = await generate({ secret });
      const result = await verify({ secret, token });
      if (!result.valid) throw new Error(JSON.stringify(result));
    },
  },
  {
    name: "otplib/functional: generate subpath",
    run: async () => {
      const secret = generateSecret();
      const token = await generateFunctional({ secret });
      const result = await verify({ secret, token });
      if (!result.valid) throw new Error(JSON.stringify(result));
    },
  },
  {
    name: "otplib/class: OTP instance",
    run: async () => {
      const secret = generateSecret();
      const otp = new OTP();
      const token = await otp.generate({ secret });
      const result = await otp.verify({ secret, token });
      if (!result.valid) throw new Error(JSON.stringify(result));
    },
  },
];

export type RequestBody = never;
export type ResponseBody = SuiteResponseBody;
export type QueryParams = never;

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await handleSuiteRequest(req, res, "otplib", () => runSuiteTests(TESTS));
}
