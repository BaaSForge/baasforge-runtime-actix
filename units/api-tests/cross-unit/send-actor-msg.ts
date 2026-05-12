/**
 * @active API LLM PROMPT EXAMPLE
 *
 * @covers API → actor fire-and-forget: `sdk.sendActorMessageSync` (no wait for handler completion) vs blocking `callActorAndWaitForResultSync`.
 * 
 * @important Do not remove unless equivalent coverage is provided elsewhere in the prompt.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { text } from "node:stream/consumers";
import { sdk, type ActorInstanceId } from "@sdk";

export type RequestBody = { actorId?: string; by?: number };
export type ResponseBody = { delivered: true };
export type QueryParams = never;

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
}
