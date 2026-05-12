import type { IncomingMessage, ServerResponse } from "node:http";

export type RequestBody = never;
export type ResponseBody = { scope: string };
export type QueryParams = never;

/**
 * Base (production) version of the runtime-scope API unit.
 * Returns the runtime scope marker so isolation tests can verify that
 * stage-a and stage-b runtimes serve their own overridden version of this
 * unit rather than the production one.
 *
 * The `-runtime-stage-a.ts` and `-runtime-stage-b.ts` siblings override
 * this unit for their respective stage runtimes.
 */
export async function handleRequest(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ scope: "production" } satisfies ResponseBody));
}
