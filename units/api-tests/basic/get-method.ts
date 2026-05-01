/**
 * @active API LLM PROMPT EXAMPLE
 *
 * @covers GET-only API unit: `never` RequestBody/QueryParams, synchronous `handleRequest`, JSON `ResponseBody` echoing `req.method`.
 * 
 * @important Do not remove unless equivalent coverage is provided elsewhere in the prompt.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

export type RequestBody = never;
export type ResponseBody = { method: string };
export type QueryParams = never;

export function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ method: req.method ?? "UNKNOWN" } satisfies ResponseBody));
}
