/**
 * `handlebars` npm package test runner (`test.runtime.api.handlebars`).
 */

import "./npm-shim-imports.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import Handlebars from "handlebars";
import HandlebarsRuntime from "handlebars/runtime";
import {
  handleSuiteRequest,
  runSuiteTests,
  type SuiteResponseBody,
  type SuiteTest,
} from "../../lib/suite-harness.js";

const TESTS: SuiteTest[] = [
  {
    name: "compile: renders template (default import)",
    run: async () => {
      const tpl = Handlebars.compile("<b>{{x}}</b>");
      if (tpl({ x: "1" }) !== "<b>1</b>") throw new Error(tpl({ x: "1" }));
    },
  },
  {
    name: "handlebars/runtime: default export is defined (subpath shim)",
    run: async () => {
      if (HandlebarsRuntime == null) throw new Error("handlebars/runtime missing default export");
      if (typeof (HandlebarsRuntime as { registerHelper?: unknown }).registerHelper !== "function") {
        throw new Error("handlebars/runtime missing registerHelper");
      }
    },
  },
];

export type RequestBody = never;
export type ResponseBody = SuiteResponseBody;
export type QueryParams = never;

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await handleSuiteRequest(req, res, "handlebars", () => runSuiteTests(TESTS));
}
