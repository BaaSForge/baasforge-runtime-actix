import { workflow, sdk } from "@sdk";

export type Input = { marker: string };
export type Output = { workerRunId: string; marker: string };

export default workflow<Input, Output>(async (_ctx, input) => {
  const enqueue = sdk.enqueueWorkerSync<{ marker: string }>(
    "test.queue-worker.queue_worker.runtime-scope-worker-target",
    { marker: input.marker },
  );
  return { workerRunId: enqueue.runId, marker: input.marker };
});
