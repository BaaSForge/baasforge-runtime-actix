import { workflow, sdk, type ActorInstanceId } from "@sdk";

const ACTOR = "test.actor-tests.actor.version-monotonic";

export type Input = { actorId: string; stepCount: number };
export type Output = { lastCount: number; stepCount: number };

export default workflow<Input, Output>(async (ctx, input) => {
  let lastCount = 0;
  for (let i = 0; i < input.stepCount; i++) {
    const r = await ctx.run(`vm-inc-${i}`, () =>
      sdk.callActorAndWaitForResultSync<Record<string, never>, { count: number }>({
        unitPath: ACTOR,
        actorId: input.actorId as ActorInstanceId,
        handler: "increment",
        payload: {},
      }),
    );
    lastCount = r.count;
  }
  return { lastCount, stepCount: input.stepCount };
});
