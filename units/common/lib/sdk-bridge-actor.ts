import { sdk, type ActorInstanceId } from "@sdk";

export function incrementViaCommon(
  actorId: ActorInstanceId,
  by = 1,
): { count: number } {
  return sdk.callActorAndWaitForResultSync<{ by: number }, { count: number }>({
    unitPath: "test.actor-tests.actor.counter",
    actorId,
    handler: "increment",
    payload: { by },
    opts: { timeoutMs: 30_000 },
  });
}
