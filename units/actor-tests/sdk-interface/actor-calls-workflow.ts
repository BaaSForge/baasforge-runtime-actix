/**
 * @active ACTOR LLM PROMPT EXAMPLE
 *
 * @covers outbound `sdk.callWorkflowAndWaitForOutputSync` from an actor handler (blocking
 * synchronous SDK call) and persisting the workflow result on `ctx.state`.
 *
 * @important Do not remove unless equivalent coverage is provided elsewhere in the prompt.
 */
import { actor, sdk } from "@sdk";

export type State = { workflowResult: number | null };
export type TriggerWorkflowInput = { n: number };
export type TriggerWorkflowOutput = State;

export default actor<State>({
  state: { workflowResult: null },
  handlers: {
    triggerWorkflow(ctx, { n }: TriggerWorkflowInput): TriggerWorkflowOutput {
      const result = sdk.callWorkflowAndWaitForOutputSync<
        { n: number }, { doubled: number }
      >({
        unitPath: "test.actor-tests.workflow.double-n",
        input: { n },
      });
      ctx.state.workflowResult = result.doubled;
      return ctx.state;
    },
  },
});
