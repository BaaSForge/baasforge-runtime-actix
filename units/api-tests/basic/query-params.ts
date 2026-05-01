import type { IncomingMessage, ServerResponse } from "node:http";

export type RequestBody = never;
export type ResponseBody = { params: Record<string, string> };
export type QueryParams = { [key: string]: string };

/**
 * Parses and echoes all query parameters from the request URL.
 * Verifies that client-supplied query string values reach the unit intact.
 */
export function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? "/", "http://localhost");
  const params: Record<string, string> = {};
  url.searchParams.forEach((value, key) => {
    params[key] = value;
  });
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ params } satisfies ResponseBody));
}
