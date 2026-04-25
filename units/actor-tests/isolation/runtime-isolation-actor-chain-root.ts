import { actor, sdk } from "@sdk";

export type State = { done: boolean };
export type RunChainInput = { marker: string; chainActorId: string; leafActorId: string };
export type RunChainOutput = {
  midScope: string;
  wfScope: string;
  marker: string;
};

export default actor<State>({
  state: { done: false },
  handlers: {
    runChain(_ctx, input: RunChainInput): RunChainOutput {
      const mid = sdk.callActorAndWaitForResultSync<
        { marker: string; leafActorId: string },
        { runtimeScope: string }
      >(
        "test.actor-tests.actor.runtime-isolation-chain-actor-mid",
        input.chainActorId,
        "toLeaf",
        { marker: input.marker, leafActorId: input.leafActorId },
      );
      const wf = sdk.callWorkflowAndWaitForOutputSync<{ marker?: string }, { runtimeScope: string }>(
        "test.actor-tests.workflow.runtime-isolation-chain-wf-leaf",
        { marker: input.marker },
      );
      return { midScope: mid.runtimeScope, wfScope: wf.runtimeScope, marker: input.marker };
    },
  },
});
