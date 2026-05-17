import type { IncomingMessage, ServerResponse } from "node:http";
import { composeNest } from "@units/test.common.common.nest-composer";

export type RequestBody = never;
export type ResponseBody = { tagA: string; tagB: string; total: number };
export type QueryParams = never;

export async function handleRequest(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = composeNest(5);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body satisfies ResponseBody));
}
