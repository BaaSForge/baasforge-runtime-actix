import type { IncomingMessage, ServerResponse } from "node:http";
import { text } from "node:stream/consumers";
import { incrementViaCommon } from "@units/test.common.common.sdk-bridge-actor";
import { echoViaCommon } from "@units/test.common.common.sdk-bridge-workflow";
import { enqueueViaCommon } from "@units/test.common.common.sdk-bridge-queue";
import type { ActorInstanceId } from "@sdk";

export type RequestBody = { actorId?: string };
export type ResponseBody = {
  actor: { count: number };
  workflow: { echoed: unknown };
  queue: { runId: string };
};
export type QueryParams = never;

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await text(req);
  let body: RequestBody = {};
  try {
    body = JSON.parse(raw) as RequestBody;
  } catch {
    // defaults
  }
  const actorId = (body.actorId ?? "common-sdk-chain-default") as ActorInstanceId;
  const actor = incrementViaCommon(actorId, 1);
  const workflow = echoViaCommon("chain");
  const queue = enqueueViaCommon({ chain: true });
  const payload: ResponseBody = {
    actor,
    workflow,
    queue: { runId: String(queue.runId) },
  };
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}
