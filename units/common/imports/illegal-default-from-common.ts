import type { IncomingMessage, ServerResponse } from "node:http";
import defaultCanary from "@units/test.common.common.default-canary";

export type RequestBody = never;
export type ResponseBody = { leaked: string };
export type QueryParams = never;

export async function handleRequest(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body: ResponseBody = { leaked: defaultCanary };
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
