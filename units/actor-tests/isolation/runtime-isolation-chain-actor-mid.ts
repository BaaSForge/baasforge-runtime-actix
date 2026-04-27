import { actor, sdk, type ActorInstanceId } from "@sdk";

export type State = { forwarded: boolean };
export type ToLeafInput = { marker: string; leafActorId: string };
export type ToLeafOutput = { runtimeScope: string };

export default actor<State>({
  state: { forwarded: false },
  handlers: {
    toLeaf(_ctx, input: ToLeafInput): ToLeafOutput {
      const out = sdk.callActorAndWaitForResultSync<{ marker?: string }, { runtimeScope: string }>({
        unitPath: "test.actor-tests.actor.runtime-isolation-chain-actor-leaf",
        actorId: input.leafActorId as ActorInstanceId,
        handler: "readScope",
        payload: { marker: input.marker },
      });
      return { runtimeScope: out.runtimeScope };
    },
  },
});
