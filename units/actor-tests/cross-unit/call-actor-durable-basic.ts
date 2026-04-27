import { workflow, sdk, type ActorInstanceId } from "@sdk";

// import type { SetInput, SetOutput } from "@units/test.actor-tests.actor.call-actor-durable-target";
type SetInput = { value: number };
type SetOutput = { ok: boolean; value: number };

export default workflow(async (_ctx, data: { actorId: string; value: number }) => {
  const result = sdk.callActorDurableAndWaitForResultSync<SetInput, SetOutput>({
    unitPath: "test.actor-tests.actor.call-actor-durable-target",
    actorId: data.actorId as ActorInstanceId,
    handler: "set",
    payload: { value: data.value },
  });
  return { ok: result.ok === true, value: result.value };
});
