import type { IncomingMessage, ServerResponse } from "node:http";
import { TAG_FROM_A, TAG_FROM_B } from "@units/test.common.common.re-export-tags";

export type RequestBody = never;
export type ResponseBody = { tagA: string; tagB: string };
export type QueryParams = never;

export async function handleRequest(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body: ResponseBody = { tagA: TAG_FROM_A, tagB: TAG_FROM_B };
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
