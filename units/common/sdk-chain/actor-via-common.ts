import type { IncomingMessage, ServerResponse } from "node:http";
import { text } from "node:stream/consumers";
import { incrementViaCommon } from "@units/test.common.common.sdk-bridge-actor";
import type { ActorInstanceId } from "@sdk";

export type RequestBody = { actorId?: string; by?: number };
export type ResponseBody = { count: number };
export type QueryParams = never;

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await text(req);
  let body: RequestBody = {};
  try {
    body = JSON.parse(raw) as RequestBody;
  } catch {
    // defaults
  }
  const actorId = (body.actorId ?? "common-sdk-actor-default") as ActorInstanceId;
  const result = incrementViaCommon(actorId, body.by ?? 1);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(result satisfies ResponseBody));
}
