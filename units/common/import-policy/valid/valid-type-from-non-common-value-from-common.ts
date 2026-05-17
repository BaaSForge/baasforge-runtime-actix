import type { IncomingMessage, ServerResponse } from "node:http";
import type { State } from "@units/test.actor-tests.actor.counter";
import { FACTOR } from "@units/test.common.common.logger";

export type RequestBody = never;
export type ResponseBody = { ok: true; factor: number };
export type QueryParams = never;

export async function handleRequest(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const _stateShape: State = { count: 0 };
  void _stateShape;
  const body: ResponseBody = { ok: true, factor: FACTOR };
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
