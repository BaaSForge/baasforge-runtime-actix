import { actor, sdk } from "@sdk";

export type State = { enqueuedRunId: string | null };
export type TriggerWorkerInput = { value: number };
export type TriggerWorkerOutput = { runId: string };

export default actor<State>({
  state: { enqueuedRunId: null },
  handlers: {
    async triggerWorker(ctx, { value }: TriggerWorkerInput): Promise<TriggerWorkerOutput> {
      const { runId } = await sdk.enqueueWorker("test.actor-tests.queue_worker.echo-target", { value });
      ctx.state.enqueuedRunId = runId;
      return { runId };
    },
  },
});
