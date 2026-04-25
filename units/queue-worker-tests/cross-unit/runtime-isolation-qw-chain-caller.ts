import { workflow, sdk } from "@sdk";

export type Input = { marker: string };
export type Output = { rootRunId: string; marker: string };

export default workflow<Input, Output>(async (_ctx, input) => {
  const { runId } = sdk.enqueueWorkerSync<{ marker: string }>(
    "test.queue-worker.queue_worker.runtime-isolation-qw-chain-root",
    { marker: input.marker },
  );
  return { rootRunId: runId, marker: input.marker };
});
