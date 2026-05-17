import type { IncomingMessage, ServerResponse } from "node:http";

export type RequestBody = never;
export type ResponseBody = { scope: string };
export type QueryParams = never;

/** Production runtime-scope harness; stage overrides use `-runtime-stage-a` / `-runtime-stage-b` suffix files. */
export async function handleRequest(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ scope: "production" } satisfies ResponseBody));
}
