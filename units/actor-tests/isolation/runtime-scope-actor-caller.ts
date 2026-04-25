import { workflow, sdk } from "@sdk";

export type Input = { actorId: string; marker: string };
export type Output = { actorScope: string; marker: string };

export default workflow<Input, Output>(async (_ctx, input) => {
  const actorResult = sdk.callActorAndWaitForResultSync<{ marker: string }, { runtimeScope: string }>(
    "test.actor-tests.actor.runtime-scope-actor-target",
    input.actorId,
    "readScope",
    { marker: input.marker },
  );
  return { actorScope: actorResult.runtimeScope, marker: input.marker };
});
