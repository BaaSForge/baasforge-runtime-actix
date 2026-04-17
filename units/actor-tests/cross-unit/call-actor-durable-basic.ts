import { workflow, sdk } from "@sdk";

export default workflow(async (_ctx, data: { actorId: string; value: number }) => {
  const result = await sdk.callActorDurable(
    "test.actor-tests.actor.call-actor-durable-target",
    data.actorId,
    "set",
    { value: data.value },
  );
  return { ok: result?.ok === true, value: result?.value as number };
});
