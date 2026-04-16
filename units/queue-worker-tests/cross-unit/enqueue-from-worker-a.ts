import { queueWorker, sdk } from "@sdk";

export type Input = { value: number };
export type Output = { enqueuedRunId: string };

export default queueWorker<Input, Output>(async (_ctx, data) => {
  const { runId } = await sdk.enqueueWorker(
    "test.queue-worker.cross-unit.enqueue-from-worker-b",
    { value: data.value },
  );
  return { enqueuedRunId: runId };
});
