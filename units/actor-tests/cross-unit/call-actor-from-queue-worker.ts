import { queueWorker, sdk, type ActorInstanceId } from "@sdk";

// import type { TouchOutput } from "@units/test.actor-tests.actor.call-actor-from-qw-target";
type TouchOutput = { ok: boolean };

export default queueWorker(async (ctx, data: { actorId: string }) => {
  const { actorId } = data;
  const result = sdk.callActorAndWaitForResultSync<void, TouchOutput>({
    unitPath: "test.actor-tests.actor.call-actor-from-qw-target",
    actorId: actorId as ActorInstanceId,
    handler: "touch",
  });
  return { ok: result.ok === true };
});
