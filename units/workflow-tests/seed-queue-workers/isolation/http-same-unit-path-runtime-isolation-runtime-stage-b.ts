import { queueWorker } from "@sdk";

export const HTTP_SAME_UNIT_PATH = "test.queue-worker.queue_worker.http-same-unit-path-runtime-isolation";

export type Input = { marker: string };
export type Output = { runtimeScope: "stage-b"; unitPath: string; marker: string };

export default queueWorker<Input, Output>(async (_ctx, data) => {
  return { runtimeScope: "stage-b", unitPath: HTTP_SAME_UNIT_PATH, marker: data.marker };
});
