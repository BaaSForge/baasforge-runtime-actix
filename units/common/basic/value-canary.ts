import type { IncomingMessage, ServerResponse } from "node:http";

export const API_VALUE_CANARY = "api-value-not-importable";

export type RequestBody = never;
export type ResponseBody = { ok: true };
export type QueryParams = never;

export async function handleRequest(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true } satisfies ResponseBody));
}
