import { workflow, sdk, type ActorInstanceId } from "@sdk";

export type Input = { actorId: string; marker: string };
export type Output = { scopeSurface: string; marker: string };

export default workflow<Input, Output>(async (ctx, input) => {
  const actorResult = await ctx.run("read-scope-surface", () =>
    sdk.callActorAndWaitForResultSync<{ marker: string }, { scopeSurface: string }>({
      unitPath: "test.actor-tests.actor.runtime-scope-actor-target",
      actorId: input.actorId as ActorInstanceId,
      handler: "readScope",
      payload: { marker: input.marker },
    }),
  );
  return { scopeSurface: actorResult.scopeSurface, marker: input.marker };
});
