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

export function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  void (async () => {
    const body = await text(req);
    const out: ResponseBody = {
      contentType: headerContentType(req),
      length: body.length,
      body,
    };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(out));
  })();
}
