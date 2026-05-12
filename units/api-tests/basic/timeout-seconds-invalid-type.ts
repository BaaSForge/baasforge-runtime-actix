import type { IncomingMessage, ServerResponse } from "node:http";

export type RequestBody = never;
export type ResponseBody = { reached: true };
export type QueryParams = never;

/**
 * Never calls `res.end()`. Seed sets `timeout_seconds` to a string; runtime must
 * ignore it and use the 30 s default (e2e in index.ts).
 */
export async function handleRequest(_req: IncomingMessage, _res: ServerResponse): Promise<void> {
  // Intentionally hangs — never calls res.end().
}
