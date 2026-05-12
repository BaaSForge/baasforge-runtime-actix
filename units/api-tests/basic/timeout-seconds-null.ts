import type { IncomingMessage, ServerResponse } from "node:http";

export type RequestBody = never;
export type ResponseBody = { reached: true };
export type QueryParams = never;

/**
 * Never calls `res.end()`. Seed sets `metadata.timeout_seconds` to JSON null;
 * runtime must use the 30 s platform default (e2e in index.ts).
 */
export async function handleRequest(_req: IncomingMessage, _res: ServerResponse): Promise<void> {
  // Intentionally hangs — never calls res.end().
}
