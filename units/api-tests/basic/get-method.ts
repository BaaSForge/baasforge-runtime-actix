import type { IncomingMessage, ServerResponse } from "node:http";

export type RequestBody = never;
export type ResponseBody = { method: string };
export type QueryParams = never;

/**
 * Returns the HTTP method of the incoming request.
 * Used to verify that different HTTP verbs reach the unit correctly.
 */
export function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ method: req.method ?? "UNKNOWN" } satisfies ResponseBody));
}
