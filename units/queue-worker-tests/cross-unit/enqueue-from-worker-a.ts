import { queueWorker, sdk } from "@sdk";

export type Input = { value: number };
export type Output = { enqueuedRunId: string };

export default queueWorker<Input, Output>(async (_ctx, data) => {
  const { runId } = sdk.enqueueWorkerSync<{ value: number }>({
    unitPath: "test.queue-worker.queue_worker.enqueue-from-worker-b",
    data: { value: data.value },
  });
  return { enqueuedRunId: runId };
});
