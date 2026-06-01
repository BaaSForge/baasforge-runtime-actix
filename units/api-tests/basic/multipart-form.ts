/**
 * @active API LLM PROMPT EXAMPLE
 *
 * @covers multipart/form-data POST: `buffer(req)` from `node:stream/consumers`, `getMultipartBoundary` + `parseMultipart` from `@mjackson/multipart-parser` on the root import (not `parseMultipartRequest` or `@mjackson/multipart-parser/node` — platform `IncomingMessage` is not a Fetch `Request` or Node `Readable`). Text fields via `part.isText` / `part.text`; file parts via `part.isFile`, `part.filename`, `part.mediaType`, and `part.bytes`.
 *
 * @important Do not remove unless equivalent coverage is provided elsewhere in the prompt.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { Buffer } from "node:buffer";
import { buffer } from "node:stream/consumers";
import { getMultipartBoundary, parseMultipart } from "@mjackson/multipart-parser";

export type RequestBody = never;
export type ResponseBody = {
  fields: Record<string, string>;
  files: Record<string, { filename: string; mediaType: string | null; byteLength: number; base64: string }[]>;
};
export type QueryParams = never;

function contentType(req: IncomingMessage): string | null {
  const v = req.headers["content-type"];
  if (v === undefined) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const boundary = getMultipartBoundary(contentType(req) ?? "");
  if (!boundary) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "multipart boundary not found" }));
    return;
  }

  const bodyBytes = await buffer(req);
  const fields: Record<string, string> = {};
  const files: ResponseBody["files"] = {};
  for (const part of parseMultipart(bodyBytes, { boundary })) {
    if (!part.name) continue;
    if (part.isText) {
      fields[part.name] = part.text;
    } else if (part.isFile) {
      const entry = {
        filename: part.filename ?? "unknown",
        mediaType: part.mediaType ?? null,
        byteLength: part.bytes.length,
        base64: Buffer.from(part.bytes).toString("base64"),
      };
      (files[part.name] ??= []).push(entry);
    }
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ fields, files } satisfies ResponseBody));
}
