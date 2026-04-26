import { actor, sdk } from "@sdk";

const ACTOR_PATH = "test.actor-tests.actor.http-same-unit-path-runtime-isolation";

type St = Record<string, never>;

export default actor<St>({
  state: {},
  handlers: {
    probeSend(
      _ctx,
      input: { childActorId: string; tag: string },
    ): { tag: string; runtimeScope: string; unitPath: string } {
      sdk.sendActorMessageSync<{ tag: string }>(ACTOR_PATH, input.childActorId, "writeTag", { tag: input.tag });
      const t = sdk.callActorAndWaitForResultSync<Record<string, never>, { tag: string }>(
        ACTOR_PATH,
        input.childActorId,
        "readTag",
        {},
      );
      const p = sdk.callActorAndWaitForResultSync<Record<string, never>, { runtimeScope: string; unitPath: string }>(
        ACTOR_PATH,
        input.childActorId,
        "probe",
        {},
      );
      return { tag: t.tag, runtimeScope: p.runtimeScope, unitPath: p.unitPath };
    },
  },
});
