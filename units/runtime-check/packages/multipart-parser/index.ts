/**
 * `@mjackson/multipart-parser` npm package test runner (`test.runtime.api.multipart-parser`).
 * No public subpaths except root (`./node` is Node-only — skipped).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  MaxFileSizeExceededError,
  MaxHeaderSizeExceededError,
  MultipartParseError,
  MultipartParser,
  MultipartPart,
  getMultipartBoundary,
  isMultipartRequest,
  parseMultipart,
  parseMultipartRequest,
  parseMultipartStream,
} from "@mjackson/multipart-parser";
import * as multipart from "@mjackson/multipart-parser";

const CRLF = "\r\n";
const BOUNDARY = "----WebKitFormBoundaryTEST";

type MultipartFixturePart = {
  name: string;
  body: string | Uint8Array;
  filename?: string;
  contentType?: string;
};

function encodeMultipart(parts: MultipartFixturePart[], boundary = BOUNDARY): Uint8Array {
  const segments: Uint8Array[] = [];
  const enc = new TextEncoder();
  const pushText = (s: string) => {
    segments.push(enc.encode(s));
  };

  for (const part of parts) {
    pushText(`--${boundary}${CRLF}`);
    if (part.filename) {
      pushText(
        `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"${CRLF}`,
      );
      pushText(`Content-Type: ${part.contentType ?? "application/octet-stream"}${CRLF}${CRLF}`);
    } else {
      pushText(`Content-Disposition: form-data; name="${part.name}"${CRLF}${CRLF}`);
    }
    if (part.body instanceof Uint8Array) {
      segments.push(part.body);
    } else {
      pushText(part.body);
    }
    pushText(CRLF);
  }
  pushText(`--${boundary}--${CRLF}`);

  const total = segments.reduce((sum, seg) => sum + seg.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const seg of segments) {
    out.set(seg, offset);
    offset += seg.length;
  }
  return out;
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

interface TestResult {
  name: string;
  pass: boolean;
  detail?: string;
  error?: string;
}

interface SuiteTest {
  name: string;
  run: () => Promise<void>;
}

async function runSuiteTests(tests: SuiteTest[]): Promise<TestResult[]> {
  const results: TestResult[] = [];
  for (const test of tests) {
    try {
      await test.run();
      results.push({ name: test.name, pass: true });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      results.push({ name: test.name, pass: false, error: msg });
    }
  }
  return results;
}

async function handleSuiteRequest(
  _req: IncomingMessage,
  res: ServerResponse,
  sectionName: string,
  collectTests: () => Promise<TestResult[]>,
): Promise<void> {
  const tests = await collectTests();
  const passed = tests.filter((t) => t.pass).length;
  const failed = tests.length - passed;
  const section = { pass: failed === 0, tests };
  const summary = {
    healthy: failed === 0,
    total_tests: tests.length,
    total_passed: passed,
    total_failed: failed,
    sections: {
      [sectionName]: { pass: section.pass, passed, failed, total: tests.length },
    },
  };
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ summary, sections: { [sectionName]: section }, tests }));
}

const TESTS: SuiteTest[] = [
  {
    name: "exports: namespace re-exports all public API",
    run: async () => {
      const keys = [
        "MaxFileSizeExceededError",
        "MaxHeaderSizeExceededError",
        "MultipartParseError",
        "MultipartParser",
        "MultipartPart",
        "getMultipartBoundary",
        "isMultipartRequest",
        "parseMultipart",
        "parseMultipartRequest",
        "parseMultipartStream",
      ] as const;
      for (const key of keys) {
        if (typeof multipart[key] === "undefined") {
          throw new Error(`missing export: ${key}`);
        }
      }
    },
  },
  {
    name: "getMultipartBoundary: unquoted boundary",
    run: async () => {
      const b = getMultipartBoundary(`multipart/form-data; boundary=${BOUNDARY}`);
      assert(b === BOUNDARY, JSON.stringify(b));
    },
  },
  {
    name: "getMultipartBoundary: quoted boundary",
    run: async () => {
      const b = getMultipartBoundary('multipart/form-data; boundary="quoted-boundary"');
      assert(b === "quoted-boundary", JSON.stringify(b));
    },
  },
  {
    name: "getMultipartBoundary: multipart/mixed",
    run: async () => {
      const b = getMultipartBoundary("multipart/mixed; boundary=mixed123");
      assert(b === "mixed123", JSON.stringify(b));
    },
  },
  {
    name: "getMultipartBoundary: null when not multipart",
    run: async () => {
      assert(getMultipartBoundary("text/plain") === null, "expected null");
      assert(getMultipartBoundary("application/json") === null, "expected null");
    },
  },
  {
    name: "isMultipartRequest: true for multipart/form-data",
    run: async () => {
      const req = new Request("http://test/", {
        method: "POST",
        headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
        body: encodeMultipart([{ name: "a", body: "1" }]),
      });
      assert(isMultipartRequest(req) === true, "expected true");
    },
  },
  {
    name: "isMultipartRequest: false for non-multipart",
    run: async () => {
      const req = new Request("http://test/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      assert(isMultipartRequest(req) === false, "expected false");
    },
  },
  {
    name: "parseMultipart: text field (isText, text, name)",
    run: async () => {
      const body = encodeMultipart([{ name: "username", body: "alice" }]);
      const parts = [...parseMultipart(body, { boundary: BOUNDARY })];
      const part = parts[0];
      assert(part instanceof MultipartPart, "expected MultipartPart");
      assert(part.name === "username", part.name ?? "");
      assert(part.text === "alice", part.text);
      assert(part.isText === true, "isText");
      assert(part.isFile === false, "isFile");
      assert(part.filename === undefined, "filename");
      assert(part.size === 5, `size ${part.size}`);
    },
  },
  {
    name: "parseMultipart: file field (isFile, filename, mediaType, bytes, arrayBuffer)",
    run: async () => {
      const fileBytes = new Uint8Array([0x66, 0x69, 0x6c, 0x65, 0xff, 0x64, 0x61, 0x74, 0x61]);
      const body = encodeMultipart([
        { name: "upload", filename: "note.bin", body: fileBytes, contentType: "application/octet-stream" },
      ]);
      const parts = [...parseMultipart(body, { boundary: BOUNDARY })];
      const part = parts[0];
      assert(part, "missing file part");
      assert(part.isFile === true, "isFile");
      assert(part.isText === false, "isText");
      assert(part.name === "upload", part.name ?? "");
      assert(part.filename === "note.bin", part.filename ?? "");
      assert(part.mediaType === "application/octet-stream", part.mediaType ?? "");
      assert(part.bytes.length === fileBytes.length, `bytes len ${part.bytes.length}`);
      assert(part.arrayBuffer.byteLength === fileBytes.length, `ab len ${part.arrayBuffer.byteLength}`);
      assert(part.size === fileBytes.length, `size ${part.size}`);
      assert(part.bytes[4] === 0xff, "opaque octet preserved");
      assert(part.content.length >= 1, "content chunks");
    },
  },
  {
    name: "parseMultipart: multiple field and file parts",
    run: async () => {
      const body = encodeMultipart([
        { name: "a", body: "1" },
        { name: "b", body: "2" },
        { name: "f1", filename: "one.bin", body: "AA" },
        { name: "f2", filename: "two.bin", body: "BB" },
      ]);
      const parts = [...parseMultipart(body, { boundary: BOUNDARY })];
      assert(parts.length === 4, `count ${parts.length}`);
      const p0 = parts[0];
      const p1 = parts[1];
      const p2 = parts[2];
      const p3 = parts[3];
      assert(p0 && p1 && p2 && p3, "missing parts");
      assert(p0.text === "1" && p1.text === "2", "fields");
      assert(p2.isFile && p3.isFile, "files");
      assert(p2.filename === "one.bin" && p3.filename === "two.bin", "filenames");
    },
  },
  {
    name: "parseMultipart: Iterable<Uint8Array> chunks",
    run: async () => {
      const body = encodeMultipart([{ name: "chunked", body: "ok" }]);
      const mid = Math.floor(body.length / 2);
      const chunks: Uint8Array[] = [body.subarray(0, mid), body.subarray(mid)];
      const parts = [...parseMultipart(chunks, { boundary: BOUNDARY })];
      const part = parts[0];
      assert(part, "missing part");
      assert(part.text === "ok", part.text);
    },
  },
  {
    name: "parseMultipart: part.headers",
    run: async () => {
      const body = encodeMultipart([{ name: "h", body: "v" }]);
      const parts = [...parseMultipart(body, { boundary: BOUNDARY })];
      const part = parts[0];
      assert(part, "missing part");
      const disp = part.headers.get("Content-Disposition");
      assert(typeof disp === "string" && disp.includes('name="h"'), disp ?? "missing header");
    },
  },
  {
    name: "parseMultipartStream: ReadableStream yields same parts",
    run: async () => {
      const body = encodeMultipart([
        { name: "s1", body: "x" },
        { name: "s2", filename: "f.dat", body: "YZ" },
      ]);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(body);
          controller.close();
        },
      });
      const parts: MultipartPart[] = [];
      for await (const part of parseMultipartStream(stream, { boundary: BOUNDARY })) {
        parts.push(part);
      }
      assert(parts.length === 2, `count ${parts.length}`);
      const p0 = parts[0];
      const p1 = parts[1];
      assert(p0 && p1, "missing parts");
      assert(p0.text === "x", p0.text);
      assert(p1.isFile && p1.bytes.length === 2, "file part");
    },
  },
  {
    name: "MultipartParser: incremental write and finish",
    run: async () => {
      const body = encodeMultipart([{ name: "inc", body: "mental" }]);
      const parser = new MultipartParser(BOUNDARY);
      assert(parser.boundary === BOUNDARY, parser.boundary);
      const defaultParser = new MultipartParser(BOUNDARY, {});
      assert(defaultParser.maxHeaderSize > 0, "maxHeaderSize");
      assert(defaultParser.maxFileSize > 0, "maxFileSize");
      const mid = Math.floor(body.length / 2);
      const parts: MultipartPart[] = [];
      for (const part of parser.write(body.subarray(0, mid))) parts.push(part);
      for (const part of parser.write(body.subarray(mid))) parts.push(part);
      parser.finish();
      assert(parts.length === 1, `count ${parts.length}`);
      const part = parts[0];
      assert(part, "missing part");
      assert(part.text === "mental", part.text);
    },
  },
  {
    name: "parseMultipartRequest: field and file from Request",
    run: async () => {
      const body = encodeMultipart([
        { name: "email", body: "a@b.c" },
        { name: "avatar", filename: "pic.png", body: "PNG", contentType: "image/png" },
      ]);
      const req = new Request("http://test/upload", {
        method: "POST",
        headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
        body,
      });
      const parts: MultipartPart[] = [];
      for await (const part of parseMultipartRequest(req)) parts.push(part);
      assert(parts.length === 2, `count ${parts.length}`);
      const p0 = parts[0];
      const p1 = parts[1];
      assert(p0 && p1, "missing parts");
      assert(p0.text === "a@b.c", p0.text);
      assert(p1.filename === "pic.png" && p1.mediaType === "image/png", "file meta");
    },
  },
  {
    name: "parseMultipartRequest: rejects non-multipart Request",
    run: async () => {
      const req = new Request("http://test/", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "nope",
      });
      let err: unknown;
      try {
        for await (const _ of parseMultipartRequest(req)) {
          void _;
        }
      } catch (e) {
        err = e;
      }
      assert(err instanceof MultipartParseError, "expected MultipartParseError");
      assert(
        err instanceof Error && err.message.includes("not a multipart"),
        (err as Error).message,
      );
    },
  },
  {
    name: "MaxFileSizeExceededError: parseMultipart over limit",
    run: async () => {
      const body = encodeMultipart([{ name: "big", filename: "large.bin", body: "x".repeat(64) }]);
      let err: unknown;
      try {
        for (const _ of parseMultipart(body, { boundary: BOUNDARY, maxFileSize: 16 })) {
          void _;
        }
      } catch (e) {
        err = e;
      }
      assert(err instanceof MaxFileSizeExceededError, "expected MaxFileSizeExceededError");
      assert(err instanceof MultipartParseError, "expected MultipartParseError subclass");
    },
  },
  {
    name: "MaxFileSizeExceededError: parseMultipartRequest over limit",
    run: async () => {
      const body = encodeMultipart([{ name: "big", filename: "large.bin", body: "y".repeat(64) }]);
      const req = new Request("http://test/", {
        method: "POST",
        headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
        body,
      });
      let err: unknown;
      try {
        for await (const _ of parseMultipartRequest(req, { maxFileSize: 8 })) {
          void _;
        }
      } catch (e) {
        err = e;
      }
      assert(err instanceof MaxFileSizeExceededError, "expected MaxFileSizeExceededError");
    },
  },
  {
    name: "MaxHeaderSizeExceededError: oversized part header",
    run: async () => {
      const longName = "n".repeat(500);
      const body = encodeMultipart([{ name: longName, body: "v" }]);
      let err: unknown;
      try {
        for (const _ of parseMultipart(body, { boundary: BOUNDARY, maxHeaderSize: 64 })) {
          void _;
        }
      } catch (e) {
        err = e;
      }
      assert(err instanceof MaxHeaderSizeExceededError, "expected MaxHeaderSizeExceededError");
      assert(err instanceof MultipartParseError, "expected MultipartParseError subclass");
    },
  },
  {
    name: "MultipartParseError: incomplete message on finish()",
    run: async () => {
      const body = encodeMultipart([{ name: "x", body: "y" }]);
      const parser = new MultipartParser(BOUNDARY);
      parser.write(body.subarray(0, body.length - 8));
      let err: unknown;
      try {
        parser.finish();
      } catch (e) {
        err = e;
      }
      assert(err instanceof MultipartParseError, "expected MultipartParseError");
      assert(!(err instanceof MaxFileSizeExceededError), "not file size error");
    },
  },
  {
    name: "MultipartParser: honors custom maxHeaderSize and maxFileSize options",
    run: async () => {
      const parser = new MultipartParser(BOUNDARY, { maxHeaderSize: 512, maxFileSize: 1024 });
      assert(parser.maxHeaderSize === 512, `maxHeaderSize ${parser.maxHeaderSize}`);
      assert(parser.maxFileSize === 1024, `maxFileSize ${parser.maxFileSize}`);
    },
  },
  {
    name: "Node pattern: parseMultipart on raw bytes (not UTF-8 string body)",
    run: async () => {
      const fileBytes = new Uint8Array([0xff, 0x00, 0x7f]);
      const body = encodeMultipart([
        { name: "f", filename: "opaque.bin", body: fileBytes, contentType: "application/octet-stream" },
      ]);
      const parts = [...parseMultipart(body, { boundary: BOUNDARY })];
      const part = parts[0];
      assert(part && part.isFile, "expected file part");
      assert(part.bytes[0] === 0xff && part.bytes[1] === 0x00 && part.bytes[2] === 0x7f, "bytes preserved");
      const lossy = new TextDecoder("utf-8", { fatal: false }).decode(body);
      const reencoded = new TextEncoder().encode(lossy);
      const lossyParts = [...parseMultipart(reencoded, { boundary: BOUNDARY })];
      const lossyPart = lossyParts[0];
      assert(
        !(lossyPart && lossyPart.isFile && Buffer.from(lossyPart.bytes).equals(Buffer.from(fileBytes))),
        "UTF-8 lossy roundtrip must not be used before parseMultipart",
      );
    },
  },
];

export type RequestBody = never;
export type ResponseBody = {
  summary: {
    healthy: boolean;
    total_tests: number;
    total_passed: number;
    total_failed: number;
    sections: Record<string, { pass: boolean; passed: number; failed: number; total: number }>;
  };
  sections: Record<string, { pass: boolean; tests: TestResult[] }>;
  tests: TestResult[];
};
export type QueryParams = never;

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await handleSuiteRequest(req, res, "multipart-parser", () => runSuiteTests(TESTS));
}
