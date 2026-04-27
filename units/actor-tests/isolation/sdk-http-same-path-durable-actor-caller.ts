import { workflow, sdk, type ActorInstanceId } from "@sdk";

const ACTOR_PATH = "test.actor-tests.actor.http-same-unit-path-runtime-isolation";

export type Input = { actorId: string };
export type Output = { runtimeScope: string; unitPath: string };

export default workflow<Input, Output>(async (_ctx, input) => {
  const r = sdk.callActorDurableAndWaitForResultSync<
    Record<string, never>,
    { runtimeScope: string; unitPath: string }
  >({
    unitPath: ACTOR_PATH,
    actorId: input.actorId as ActorInstanceId,
    handler: "probe",
    payload: {},
  });
  return { runtimeScope: r.runtimeScope, unitPath: r.unitPath };
});
