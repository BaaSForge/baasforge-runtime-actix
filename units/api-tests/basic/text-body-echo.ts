/**
 * @active API LLM PROMPT EXAMPLE
 *
 * @covers Non-JSON request body (`text/plain`), `text(req)`, echoing content-type and length in JSON `ResponseBody`.
 * 
 * @important Do not remove unless equivalent coverage is provided elsewhere in the prompt.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { text } from "node:stream/consumers";

export type RequestBody = never;
export type ResponseBody = {
  contentType: string | null;
  length: number;
  body: string;
};
export type QueryParams = never;

function headerContentType(req: IncomingMessage): string | null {
  const v = req.headers["content-type"];
  if (v === undefined) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await text(req);
  const out: ResponseBody = {
    contentType: headerContentType(req),
    length: body.length,
    body,
  };
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(out));
}
