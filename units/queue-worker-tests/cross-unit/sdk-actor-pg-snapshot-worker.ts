import { queueWorker, sdk, type ActorInstanceId } from "@sdk";

const ACTOR = "test.actor-tests.actor.version-monotonic";

export default queueWorker<
  { actorId: string; stepCount: number },
  { lastCount: number; stepCount: number }
>(async (_ctx, data) => {
  let lastCount = 0;
  for (let i = 0; i < data.stepCount; i++) {
    const r = sdk.callActorAndWaitForResultSync<Record<string, never>, { count: number }>({
      unitPath: ACTOR,
      actorId: data.actorId as ActorInstanceId,
      handler: "increment",
      payload: {},
    });
    lastCount = r.count;
  }
  return { lastCount, stepCount: data.stepCount };
});
