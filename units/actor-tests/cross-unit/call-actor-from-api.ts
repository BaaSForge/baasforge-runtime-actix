import { queueWorker, sdk } from "@sdk";

export default queueWorker(async (ctx, data) => {
  const { actorId } = data;
  const result = await sdk.callActor("test.actor-tests.actor.call-actor-from-api-target", actorId, "store", { value: 42 });
  return { ok: result?.ok === true };
});
