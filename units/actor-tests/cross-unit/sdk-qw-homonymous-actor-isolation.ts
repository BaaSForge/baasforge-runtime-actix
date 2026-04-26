import { queueWorker, sdk } from "@sdk";

const ACTOR_PATH = "test.actor-tests.actor.http-same-unit-path-runtime-isolation";

export default queueWorker<{ actorId: string }, { runtimeScope: string; unitPath: string }>(
  async (_ctx, data) => {
    const r = sdk.callActorAndWaitForResultSync<Record<string, never>, { runtimeScope: string; unitPath: string }>(
      ACTOR_PATH,
      data.actorId,
      "probe",
      {},
    );
    return { runtimeScope: r.runtimeScope, unitPath: r.unitPath };
  },
);
