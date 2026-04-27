import { workflow, sdk, type ActorInstanceId } from "@sdk";

export type Input = { marker: string; rootActorId: string; chainActorId: string; leafActorId: string };
export type Output = {
  midScope: string;
  wfScope: string;
  marker: string;
};

export default workflow<Input, Output>(async (ctx, input) => {
  const out = await ctx.run("actor-root-chain", () =>
    sdk.callActorAndWaitForResultSync<
      { marker: string; chainActorId: string; leafActorId: string },
      { midScope: string; wfScope: string; marker: string }
    >({
      unitPath: "test.actor-tests.actor.runtime-isolation-actor-chain-root",
      actorId: input.rootActorId as ActorInstanceId,
      handler: "runChain",
      payload: {
        marker: input.marker,
        chainActorId: input.chainActorId,
        leafActorId: input.leafActorId,
      },
    }),
  );
  return { midScope: out.midScope, wfScope: out.wfScope, marker: out.marker };
});
