import { workflow, sdk, type ActorInstanceId } from "@sdk";

// import type { State } from "@units/test.actor-tests.actor.call-actor-durable-target";
type State = { value: number | null; callCount: number };

export default workflow(async (ctx, data: { actorId: string }) => {
  try {
    await ctx.run("call-actor", (): State =>
      sdk.callActorAndWaitForResultSync<unknown, State>({
        unitPath: "test.actor-tests.actor.call-actor-durable-target",
        actorId: data.actorId as ActorInstanceId,
        handler: "handlerDoesNotExist",
        payload: {},
      }),
    );
    return { caught: false, error: null };
  } catch (e: unknown) {
    return { caught: true, error: e instanceof Error ? e.message : String(e) };
  }
});
