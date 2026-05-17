import type { IncomingMessage, ServerResponse } from "node:http";
import { ACTOR_VALUE_CANARY } from "@units/test.actor-tests.actor.export-canary";

export type RequestBody = never;
export type ResponseBody = { leaked: number };
export type QueryParams = never;

export async function handleRequest(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body: ResponseBody = { leaked: ACTOR_VALUE_CANARY };
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
