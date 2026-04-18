import { actor, sdk } from "@sdk";

export type State = { workflowResult: number | null };
export type TriggerWorkflowInput = { n: number };
export type TriggerWorkflowOutput = State;

export default actor<State>({
  state: { workflowResult: null },
  handlers: {
    async triggerWorkflow(ctx, { n }: TriggerWorkflowInput): Promise<TriggerWorkflowOutput> {
      const result = await sdk.callWorkflow("test.actor-tests.workflow.double-n", { n });
      ctx.state.workflowResult = result?.doubled ?? result;
      return ctx.state;
    },
  },
});
