/**
 * Formidable library test runner (`test.runtime.api.formidable`).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import formidable from "formidable";
import {
  handleSuiteRequest,
  runSuiteTests,
  type SuiteResponseBody,
  type SuiteTest,
} from "../../lib/suite-harness.js";

function multipartRequest(body: string, boundary: string): IncomingMessage {
  const req = new Readable({
    read() {
      this.push(body);
      this.push(null);
    },
  }) as IncomingMessage;
  req.headers = {
    "content-type": `multipart/form-data; boundary=${boundary}`,
    "content-length": String(Buffer.byteLength(body)),
  };
  return req;
}

const TESTS: SuiteTest[] = [
  {
    name: "parse: multipart fields + file",
    run: async () => {
      const boundary = "----formidable-runtime-check";
      const body = [
        `--${boundary}`,
        'Content-Disposition: form-data; name="title"',
        "",
        "hello",
        `--${boundary}`,
        'Content-Disposition: form-data; name="upload"; filename="a.txt"',
        "Content-Type: text/plain",
        "",
        "abc",
        `--${boundary}--`,
        "",
      ].join("\r\n");

      const form = formidable({ multiples: false });
      const [fields, files] = await form.parse(multipartRequest(body, boundary));
      if (fields["title"]?.[0] !== "hello") {
        throw new Error(`title: ${JSON.stringify(fields)}`);
      }
      if (!files["upload"]?.[0]) {
        throw new Error(`upload: ${JSON.stringify(files)}`);
      }
    },
  },
];

export type RequestBody = never;
export type ResponseBody = SuiteResponseBody;
export type QueryParams = never;

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await handleSuiteRequest(req, res, "formidable", () => runSuiteTests(TESTS));
}
