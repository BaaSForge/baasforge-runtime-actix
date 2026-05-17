import type { IncomingMessage, ServerResponse } from "node:http";
import { API_VALUE_CANARY } from "@units/test.common.api.value-canary";

export type RequestBody = never;
export type ResponseBody = { leaked: string };
export type QueryParams = never;

export async function handleRequest(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body: ResponseBody = { leaked: API_VALUE_CANARY };
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
