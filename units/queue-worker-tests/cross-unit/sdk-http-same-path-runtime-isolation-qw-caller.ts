import { workflow, sdk } from "@sdk";

export type Input = { marker: string };
export type Output = { enqueuedRunId: string; marker: string };

export default workflow<Input, Output>(async (_ctx, input) => {
  const { runId } = sdk.enqueueWorkerSync<{ marker: string }>(
    "test.queue-worker.queue_worker.http-same-unit-path-runtime-isolation",
    { marker: input.marker },
  );
  return { enqueuedRunId: runId, marker: input.marker };
});
