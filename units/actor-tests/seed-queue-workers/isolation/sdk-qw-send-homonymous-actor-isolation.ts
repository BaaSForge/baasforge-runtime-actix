import { queueWorker, sdk, type ActorInstanceId } from "@sdk";

const ACTOR_PATH = "test.actor-tests.actor.http-same-unit-path-runtime-isolation";

export default queueWorker<
  { actorId: string; tag: string },
  { tag: string; runtimeScope: string; unitPath: string }
>(async (_ctx, data) => {
  sdk.callActorAndWaitForResultSync<{ tag: string }, Record<string, never>>({
    unitPath: ACTOR_PATH,
    actorId: data.actorId as ActorInstanceId,
    handler: "writeTag",
    payload: { tag: data.tag },
  });
  const t = sdk.callActorAndWaitForResultSync<Record<string, never>, { tag: string }>({
    unitPath: ACTOR_PATH,
    actorId: data.actorId as ActorInstanceId,
    handler: "readTag",
    payload: {},
  });
  const p = sdk.callActorAndWaitForResultSync<Record<string, never>, { runtimeScope: string; unitPath: string }>({
    unitPath: ACTOR_PATH,
    actorId: data.actorId as ActorInstanceId,
    handler: "probe",
    payload: {},
  });
  return { tag: t.tag, runtimeScope: p.runtimeScope, unitPath: p.unitPath };
});
