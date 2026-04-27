import { actor, sdk, type ActorInstanceId } from "@sdk";

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
      >({
        unitPath: "test.actor-tests.actor.runtime-isolation-chain-actor-mid",
        actorId: input.chainActorId as ActorInstanceId,
        handler: "toLeaf",
        payload: { marker: input.marker, leafActorId: input.leafActorId },
      });
      const wf = sdk.callWorkflowAndWaitForOutputSync<{ marker?: string }, { runtimeScope: string }>({
        unitPath: "test.actor-tests.workflow.runtime-isolation-chain-wf-leaf",
        input: { marker: input.marker },
      });
      return { midScope: mid.runtimeScope, wfScope: wf.runtimeScope, marker: input.marker };
    },
  },
});
