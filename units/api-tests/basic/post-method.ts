import type { IncomingMessage, ServerResponse } from "node:http";

export type RequestBody = never;
export type ResponseBody = { method: string };
export type QueryParams = never;

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ method: req.method ?? "UNKNOWN" } satisfies ResponseBody));
}
