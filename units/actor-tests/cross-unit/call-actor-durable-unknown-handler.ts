import { workflow, sdk } from "@sdk";

export default workflow(async (_ctx, data: { actorId: string }) => {
  try {
    await sdk.callActorDurable(
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
