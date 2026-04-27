import { workflow, sdk, type ActorInstanceId } from "@sdk";

export type Input = { actorId: string };
export type Output = { runtimeScope: string; unitPath: string };

export default workflow<Input, Output>(async (_ctx, input) => {
  const actorResult = sdk.callActorAndWaitForResultSync<
    Record<string, never>,
    { runtimeScope: string; unitPath: string }
  >({
    unitPath: "test.actor-tests.actor.http-same-unit-path-runtime-isolation",
    actorId: input.actorId as ActorInstanceId,
    handler: "probe",
    payload: {},
  });
  return { runtimeScope: actorResult.runtimeScope, unitPath: actorResult.unitPath };
});
