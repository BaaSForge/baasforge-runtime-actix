/**
 * `libphonenumber-js` npm package test runner (`test.runtime.api.libphonenumber-js`).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { isValidPhoneNumber, parsePhoneNumber } from "libphonenumber-js";
import { parsePhoneNumber as parseMin } from "libphonenumber-js/min";
import { parsePhoneNumber as parseMax } from "libphonenumber-js/max";
import { parsePhoneNumber as parseMobile } from "libphonenumber-js/mobile";
import { parsePhoneNumberFromString } from "libphonenumber-js/core";
import {
  handleSuiteRequest,
  runSuiteTests,
  type SuiteResponseBody,
  type SuiteTest,
} from "../../lib/suite-harness.js";

const US_NUMBER = "+14155552671";

const TESTS: SuiteTest[] = [
  {
    name: "isValidPhoneNumber + parsePhoneNumber (root)",
    run: async () => {
      if (!isValidPhoneNumber(US_NUMBER)) throw new Error("expected valid US number");
      const phone = parsePhoneNumber(US_NUMBER);
      if (phone.country !== "US") throw new Error(phone.country ?? "missing country");
    },
  },
  {
    name: "libphonenumber-js/min: parsePhoneNumber",
    run: async () => {
      const phone = parseMin(US_NUMBER);
      if (phone.country !== "US") throw new Error(phone.country ?? "missing country");
    },
  },
  {
    name: "libphonenumber-js/max: parsePhoneNumber",
    run: async () => {
      const phone = parseMax(US_NUMBER);
      if (phone.country !== "US") throw new Error(phone.country ?? "missing country");
    },
  },
  {
    name: "libphonenumber-js/mobile: parsePhoneNumber",
    run: async () => {
      const phone = parseMobile(US_NUMBER);
      if (phone.country !== "US") throw new Error(phone.country ?? "missing country");
    },
  },
  {
    name: "libphonenumber-js/core: parsePhoneNumberFromString export",
    run: async () => {
      if (typeof parsePhoneNumberFromString !== "function") {
        throw new Error(`expected function, got ${typeof parsePhoneNumberFromString}`);
      }
    },
  },
];

export type RequestBody = never;
export type ResponseBody = SuiteResponseBody;
export type QueryParams = never;

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await handleSuiteRequest(req, res, "libphonenumber-js", () => runSuiteTests(TESTS));
}
