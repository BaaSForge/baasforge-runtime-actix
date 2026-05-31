/**
 * `dayjs` npm package test runner (`test.runtime.api.dayjs`).
 */

import "./npm-shim-imports.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import relativeTime from "dayjs/plugin/relativeTime";
import "dayjs/locale/fa";
import {
  handleSuiteRequest,
  runSuiteTests,
  type SuiteResponseBody,
  type SuiteTest,
} from "../../lib/suite-harness.js";

const TESTS: SuiteTest[] = [
  {
    name: "format: ISO date string",
    run: async () => {
      const formatted = dayjs("2024-06-15").format("YYYY-MM-DD");
      if (formatted !== "2024-06-15") throw new Error(formatted);
    },
  },
  {
    name: "add: days",
    run: async () => {
      const next = dayjs("2024-01-01").add(30, "day").format("YYYY-MM-DD");
      if (next !== "2024-01-31") throw new Error(next);
    },
  },
  {
    name: "plugin/utc: utc mode",
    run: async () => {
      dayjs.extend(utc);
      const h = dayjs.utc("2024-01-01T12:00:00Z").hour();
      if (h !== 12) throw new Error(String(h));
    },
  },
  {
    name: "plugin/relativeTime: fromNow",
    run: async () => {
      dayjs.extend(relativeTime);
      const label = dayjs("2020-01-01").fromNow(true);
      if (typeof label !== "string" || label.length < 2) throw new Error(label);
    },
  },
  {
    name: "locale/fa: localized month",
    run: async () => {
      dayjs.locale("fa");
      const m = dayjs("2024-01-15").format("MMMM");
      if (typeof m !== "string" || m.length < 2) throw new Error(m);
    },
  },
];

export type RequestBody = never;
export type ResponseBody = SuiteResponseBody;
export type QueryParams = never;

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await handleSuiteRequest(req, res, "dayjs", () => runSuiteTests(TESTS));
}
