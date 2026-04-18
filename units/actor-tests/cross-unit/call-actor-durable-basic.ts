import { workflow, sdk } from "@sdk";

// import type { SetInput, SetOutput } from "@units/test.actor-tests.actor.call-actor-durable-target";
type SetInput = { value: number };
type SetOutput = { ok: boolean; value: number };

export default workflow(async (_ctx, data: { actorId: string; value: number }) => {
  const result = await sdk.callActorDurable<SetInput, SetOutput>(
    "test.actor-tests.actor.call-actor-durable-target",
    data.actorId,
    "set",
    { value: data.value },
  );
  return { ok: result?.ok === true, value: result?.value as number };
});
