import type { IncomingMessage, ServerResponse } from "node:http";

export type RequestBody = never;
export type ResponseBody = { scope: string };
export type QueryParams = never;

/**
 * Stage-A override of the runtime-scope unit.
 * Seeded only into the stage-a runtime release; the production runtime
 * continues to serve `basic/runtime-scope.ts` instead.
 */
export function handleRequest(_req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ scope: "stage-a" } satisfies ResponseBody));
}
