import type { IncomingMessage, ServerResponse } from "node:http";
import type { SizeTag } from "@units/test.common.common.export-type-value";
import { SIZE } from "@units/test.common.common.export-type-value";

export type RequestBody = never;
export type ResponseBody = { size: string; tagMatches: boolean };
export type QueryParams = never;

export async function handleRequest(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const tag: SizeTag = SIZE;
  const body: ResponseBody = { size: SIZE, tagMatches: tag === "sm" };
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
