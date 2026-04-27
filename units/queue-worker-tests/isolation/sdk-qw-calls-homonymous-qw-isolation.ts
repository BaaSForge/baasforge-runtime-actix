import { queueWorker, sdk } from "@sdk";

const QW_PATH = "test.queue-worker.queue_worker.http-same-unit-path-runtime-isolation";

export default queueWorker<{ marker: string }, { nestedRunId: string; marker: string }>(async (_ctx, data) => {
  const { runId } = sdk.enqueueWorkerSync<{ marker: string }>({
    unitPath: QW_PATH,
    data: { marker: data.marker },
  });
  return { nestedRunId: runId, marker: data.marker };
});
