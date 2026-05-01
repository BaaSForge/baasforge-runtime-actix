import type { IncomingMessage, ServerResponse } from "node:http";

export type RequestBody = never;
export type ResponseBody = { reached: true };
export type QueryParams = never;

/**
 * Never calls `res.end()`. Test seed sets `project_units.metadata` to
 * `{"method":"GET","timeout_seconds":2}`; the runtime enforces that deadline in Rust.
 */
export function handleRequest(_req: IncomingMessage, _res: ServerResponse): void {
  // Intentionally hangs — never calls res.end().
}
