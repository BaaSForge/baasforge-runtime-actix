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
