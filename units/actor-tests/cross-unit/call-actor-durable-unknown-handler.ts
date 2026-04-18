import { workflow, sdk } from "@sdk";

// import type { State } from "@units/test.actor-tests.actor.call-actor-durable-target";
type State = { value: number | null; callCount: number };

export default workflow(async (_ctx, data: { actorId: string }) => {
  try {
    sdk.callActorDurableAndWaitForResultSync<unknown, State>(
      "test.actor-tests.actor.call-actor-durable-target",
      data.actorId,
      "handlerDoesNotExist",
      {},
    );
    return { caught: false, error: null };
  } catch (e: unknown) {
    return { caught: true, error: e instanceof Error ? e.message : String(e) };
  }
});
