import { actor, sdk, type ActorInstanceId } from "@sdk";

const ACTOR_PATH = "test.actor-tests.actor.http-same-unit-path-runtime-isolation";

type St = Record<string, never>;

export default actor<St>({
  state: {},
  handlers: {
    probeSend(
      _ctx,
      input: { childActorId: string; tag: string },
    ): { tag: string; runtimeScope: string; unitPath: string } {
      sdk.callActorAndWaitForResultSync<{ tag: string }, { ok: true }>({
        unitPath: ACTOR_PATH,
        actorId: input.childActorId as ActorInstanceId,
        handler: "writeTag",
        payload: { tag: input.tag },
      });
      const t = sdk.callActorAndWaitForResultSync<Record<string, never>, { tag: string }>({
        unitPath: ACTOR_PATH,
        actorId: input.childActorId as ActorInstanceId,
        handler: "readTag",
        payload: {},
      });
      const p = sdk.callActorAndWaitForResultSync<Record<string, never>, { runtimeScope: string; unitPath: string }>({
        unitPath: ACTOR_PATH,
        actorId: input.childActorId as ActorInstanceId,
        handler: "probe",
        payload: {},
      });
      return { tag: t.tag, runtimeScope: p.runtimeScope, unitPath: p.unitPath };
    },
  },
});
