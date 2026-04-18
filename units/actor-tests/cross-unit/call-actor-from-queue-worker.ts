import { queueWorker, sdk } from "@sdk";

// import type { TouchOutput } from "@units/test.actor-tests.actor.call-actor-from-qw-target";
type TouchOutput = { ok: boolean };

export default queueWorker(async (ctx, data: { actorId: string }) => {
  const { actorId } = data;
  const result = await sdk.callActor<void, TouchOutput>("test.actor-tests.actor.call-actor-from-qw-target", actorId, "touch");
  return { ok: result?.ok === true };
});
