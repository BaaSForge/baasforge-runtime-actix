import type { IncomingMessage, ServerResponse } from "node:http";

export type RequestBody = never;
export type ResponseBody = { reached: true };
export type QueryParams = never;

/**
 * Never calls `res.end()`. Seed sets `metadata.timeout_seconds` to `0`; runtime
 * must treat that like absent and apply the 30 s platform default (e2e: index.ts
 * `default-platform-30s-timeout-metadata-scenarios-sequential-e2e`).
 */
export function handleRequest(_req: IncomingMessage, _res: ServerResponse): void {
  // Intentionally hangs — never calls res.end().
}
