/**
 * @active ACTOR LLM PROMPT EXAMPLE
 *
 * @covers outbound `sdk.enqueueWorkerSync` from an actor handler (`unitPath`, `data`) and
 * storing the returned `runId` on `ctx.state`.
 *
 * @important Do not remove unless equivalent coverage is provided elsewhere in the prompt.
 */
import { actor, sdk } from "@sdk";

export type State = { enqueuedRunId: string | null };
export type TriggerWorkerInput = { value: number };
export type TriggerWorkerOutput = { runId: string };

export default actor<State>({
  state: { enqueuedRunId: null },
  handlers: {
    triggerWorker(ctx, { value }: TriggerWorkerInput): TriggerWorkerOutput {
      const { runId } = sdk.enqueueWorkerSync<{ value: number }>({
        unitPath: "test.actor-tests.queue_worker.echo-target",
        data: { value },
      });
      ctx.state.enqueuedRunId = runId;
      return { runId };
    },
  },
});
