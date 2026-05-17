import type { IncomingMessage, ServerResponse } from "node:http";
import { STAGE_MARKER } from "@units/test.common.common.stage-value";

export type RequestBody = never;
export type ResponseBody = { marker: string };
export type QueryParams = never;

export async function handleRequest(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ marker: STAGE_MARKER } satisfies ResponseBody));
}
