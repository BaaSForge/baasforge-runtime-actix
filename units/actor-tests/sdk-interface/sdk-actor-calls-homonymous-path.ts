import { actor, sdk, type ActorInstanceId } from "@sdk";

const TARGET = "test.actor-tests.actor.http-same-unit-path-runtime-isolation";

type St = Record<string, never>;

export default actor<St>({
  state: {},
  handlers: {
    probeHomonymous(_ctx, input: { childActorId: string }): { runtimeScope: string; unitPath: string } {
      return sdk.callActorAndWaitForResultSync<
        Record<string, never>,
        { runtimeScope: string; unitPath: string }
      >({
        unitPath: TARGET,
        actorId: input.childActorId as ActorInstanceId,
        handler: "probe",
        payload: {},
      });
    },
  },
});
