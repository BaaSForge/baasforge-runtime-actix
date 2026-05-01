import type { IncomingMessage, ServerResponse } from "node:http";
import { text } from "node:stream/consumers";
import { sdk, type ActorInstanceId } from "@sdk";

export type RequestBody = { actorId?: string; by?: number };
export type ResponseBody = { delivered: true };
export type QueryParams = never;

/**
 * Sends a fire-and-forget message to the companion `counter` actor via
 * `sdk.sendActorMessageSync`.
 *
 * Does NOT wait for the actor to process the message — returns
 * `{ delivered: true }` as soon as the platform accepts the dispatch.
 *
 * Request body:
 *   actorId — actor instance id (default: "api-test-send-default")
 *   by      — increment amount (default: 1)
 */
export function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  void (async () => {
    const raw = await text(req);
    let body: RequestBody = {};
    try {
      body = JSON.parse(raw) as RequestBody;
    } catch {
      // use defaults
    }

    const actorId = (body.actorId ?? "api-test-send-default") as ActorInstanceId;
    const by = body.by ?? 1;

    const result = sdk.sendActorMessageSync<{ by: number }>({
      unitPath: "test.actor-tests.actor.counter",
      actorId,
      handler: "increment",
      payload: { by },
    });

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result satisfies ResponseBody));
  })();
}
