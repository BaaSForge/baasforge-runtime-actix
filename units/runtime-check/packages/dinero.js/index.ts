/**
 * `dinero.js` npm package test runner (`test.runtime.api.dinero.js`).
 */

import "./npm-shim-imports.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dinero, add } from "dinero.js";
import { USD } from "dinero.js/currencies";
import { dinero as dineroBigint } from "dinero.js/bigint";
import { USD as UsdBigint } from "dinero.js/bigint/currencies";
import {
  handleSuiteRequest,
  runSuiteTests,
  type SuiteResponseBody,
  type SuiteTest,
} from "../../lib/suite-harness.js";

const TESTS: SuiteTest[] = [
  {
    name: "dinero: add amounts",
    run: async () => {
      const a = dinero({ amount: 1999, currency: USD });
      const b = dinero({ amount: 160, currency: USD });
      const total = add(a, b);
      if (total.toJSON().amount !== 2159) throw new Error(String(total.toJSON().amount));
    },
  },
  {
    name: "dinero.js/currencies: USD code",
    run: async () => {
      if (USD.code !== "USD") throw new Error(USD.code);
    },
  },
  {
    name: "dinero.js/bigint: amount",
    run: async () => {
      const d = dineroBigint({ amount: 100n, currency: UsdBigint });
      if (d.toJSON().amount !== 100n) throw new Error(String(d.toJSON().amount));
    },
  },
];

export type RequestBody = never;
export type ResponseBody = SuiteResponseBody;
export type QueryParams = never;

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await handleSuiteRequest(req, res, "dinero.js", () => runSuiteTests(TESTS));
}
