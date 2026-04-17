import { actor, sdk } from "@sdk";

type State = { enqueuedRunId: string | null };

export default actor<State>({
  state: { enqueuedRunId: null },
  handlers: {
    async triggerWorker(ctx, { value }: { value: number }) {
      const { runId } = await sdk.enqueueWorker("test.actor-tests.queue_worker.echo-target", { value });
      ctx.state.enqueuedRunId = runId;
      return { runId };
    },
  },
});
