import type { IncomingMessage, ServerResponse } from "node:http";
import { text } from "node:stream/consumers";
import { sdk, type ActorInstanceId } from "@sdk";

const ACTOR = "test.actor-tests.actor.offset-increment" as const;

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
  const actorId = (body.actorId ?? "offset-common-default") as ActorInstanceId;
  const result = sdk.callActorAndWaitForResultSync<{ by?: number }, { count: number }>({
    unitPath: ACTOR,
    actorId,
    handler: "increment",
    payload: { by: body.by ?? 1 },
    opts: { timeoutMs: 30_000 },
  });
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(result satisfies ResponseBody));
}
