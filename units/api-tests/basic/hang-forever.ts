import type { IncomingMessage, ServerResponse } from "node:http";

export type RequestBody = never;
export type ResponseBody = { reached: true };
export type QueryParams = never;

/**
 * Never calls `res.end()`. Seed omits `metadata.timeout_seconds`; runtime uses the 30 s default.
 */
export function handleRequest(_req: IncomingMessage, _res: ServerResponse): void {
  // Intentionally hangs — never calls res.end().
}
