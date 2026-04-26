import { queueWorker, sdk } from "@sdk";

const ACTOR_PATH = "test.actor-tests.actor.http-same-unit-path-runtime-isolation";

export default queueWorker<
  { actorId: string; tag: string },
  { tag: string; runtimeScope: string; unitPath: string }
>(async (_ctx, data) => {
  sdk.sendActorMessageSync<{ tag: string }>(ACTOR_PATH, data.actorId, "writeTag", { tag: data.tag });
  const t = sdk.callActorAndWaitForResultSync<Record<string, never>, { tag: string }>(
    ACTOR_PATH,
    data.actorId,
    "readTag",
    {},
  );
  const p = sdk.callActorAndWaitForResultSync<Record<string, never>, { runtimeScope: string; unitPath: string }>(
    ACTOR_PATH,
    data.actorId,
    "probe",
    {},
  );
  return { tag: t.tag, runtimeScope: p.runtimeScope, unitPath: p.unitPath };
});
