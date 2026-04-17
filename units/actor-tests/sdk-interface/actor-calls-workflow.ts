import { actor, sdk } from "@sdk";

type State = { workflowResult: number | null };

export default actor<State>({
  state: { workflowResult: null },
  handlers: {
    async triggerWorkflow(ctx, { n }: { n: number }) {
      const result = await sdk.callWorkflow("test.actor-tests.workflow.double-n", { n });
      ctx.state.workflowResult = result?.doubled ?? result;
      return ctx.state;
    },
  },
});
