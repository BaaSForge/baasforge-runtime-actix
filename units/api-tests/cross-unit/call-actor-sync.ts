import type { IncomingMessage, ServerResponse } from "node:http";
import { text } from "node:stream/consumers";
import { sdk, type ActorInstanceId } from "@sdk";

export type RequestBody = { actorId?: string; handler?: "get" | "increment" | "reset"; by?: number };
export type ResponseBody = { count: number };
export type QueryParams = never;

/**
 * Calls the companion `counter` actor via `sdk.callActorAndWaitForResultSync`.
 *
 * Request body:
 *   actorId  — actor instance id (default: "api-test-counter-default")
 *   handler  — "get" | "increment" | "reset" (default: "increment")
 *   by       — increment amount when handler="increment" (default: 1)
 *
 * Returns { count: number } — the counter value after the handler returns.
 */
export function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  void (async () => {
    const raw = await text(req);
    let body: RequestBody = {};
    try {
      body = JSON.parse(raw) as RequestBody;
    } catch {
      // use defaults on invalid JSON
    }

    const actorId = (body.actorId ?? "api-test-counter-default") as ActorInstanceId;
    const handler = body.handler ?? "increment";

    let result: { count: number };

    if (handler === "increment") {
      const by = body.by ?? 1;
      result = sdk.callActorAndWaitForResultSync<{ by: number }, { count: number }>({
        unitPath: "test.actor-tests.actor.counter",
        actorId,
        handler: "increment",
        payload: { by },
        opts: { timeoutMs: 30_000 },
      });
    } else {
      // "get" and "reset" take no meaningful payload
      result = sdk.callActorAndWaitForResultSync<Record<string, never>, { count: number }>({
        unitPath: "test.actor-tests.actor.counter",
        actorId,
        handler,
        payload: {},
        opts: { timeoutMs: 30_000 },
      });
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result satisfies ResponseBody));
  })();
}
