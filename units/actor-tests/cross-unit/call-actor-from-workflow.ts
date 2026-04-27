import { workflow, sdk, type ActorInstanceId } from "@sdk";

// import type { SetInput, SetOutput } from "@units/test.actor-tests.actor.call-actor-from-workflow-target";
type SetInput = { value: number };
type SetOutput = { ok: boolean };

export default workflow(async (ctx, data: { actorId: string; value: number }) => {
  const { actorId, value } = data;
  const result = await ctx.run("call-actor", (): SetOutput =>
    sdk.callActorAndWaitForResultSync<SetInput, SetOutput>({
      unitPath: "test.actor-tests.actor.call-actor-from-workflow-target",
      actorId: actorId as ActorInstanceId,
      handler: "set",
      payload: { value },
    }),
  );
  return { ok: result?.ok === true };
});
