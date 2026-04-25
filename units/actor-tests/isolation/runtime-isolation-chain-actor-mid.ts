import { actor, sdk } from "@sdk";

export type State = { forwarded: boolean };
export type ToLeafInput = { marker: string; leafActorId: string };
export type ToLeafOutput = { runtimeScope: string };

export default actor<State>({
  state: { forwarded: false },
  handlers: {
    toLeaf(_ctx, input: ToLeafInput): ToLeafOutput {
      const out = sdk.callActorAndWaitForResultSync<{ marker?: string }, { runtimeScope: string }>(
        "test.actor-tests.actor.runtime-isolation-chain-actor-leaf",
        input.leafActorId,
        "readScope",
        { marker: input.marker },
      );
      return { runtimeScope: out.runtimeScope };
    },
  },
});
