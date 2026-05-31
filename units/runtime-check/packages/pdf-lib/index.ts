/**
 * `pdf-lib` npm package test runner (`test.runtime.api.pdf-lib`).
 * No public npm subpaths — root import only.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { PDFDocument, StandardFonts } from "pdf-lib";
import {
  handleSuiteRequest,
  runSuiteTests,
  type SuiteResponseBody,
  type SuiteTest,
} from "../../lib/suite-harness.js";

const TESTS: SuiteTest[] = [
  {
    name: "PDFDocument.create: save yields non-empty bytes",
    run: async () => {
      const pdf = await PDFDocument.create();
      const page = pdf.addPage([200, 200]);
      const font = await pdf.embedFont(StandardFonts.Helvetica);
      page.drawText("ok", { x: 20, y: 150, size: 12, font });
      const bytes = await pdf.save();
      if (bytes.length < 100) throw new Error(`unexpected pdf size: ${bytes.length}`);
    },
  },
];

export type RequestBody = never;
export type ResponseBody = SuiteResponseBody;
export type QueryParams = never;

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await handleSuiteRequest(req, res, "pdf-lib", () => runSuiteTests(TESTS));
}
