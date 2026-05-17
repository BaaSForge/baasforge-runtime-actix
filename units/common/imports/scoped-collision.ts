import type { IncomingMessage, ServerResponse } from "node:http";
import { bothScopes } from "@units/test.common.common.scope-composer";

export type RequestBody = never;
export type ResponseBody = { a: number; b: number };
export type QueryParams = never;

export async function handleRequest(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = bothScopes();
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body satisfies ResponseBody));
}
