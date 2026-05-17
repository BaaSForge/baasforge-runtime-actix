import type { IncomingMessage, ServerResponse } from "node:http";

export type RequestBody = never;
export type ResponseBody = { ok: true };
export type QueryParams = never;

/** Minimal API harness — replace with real common-unit checks when runtime exists. */
export async function handleRequest(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true } satisfies ResponseBody));
}
