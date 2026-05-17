import { sdk, type QueueWorkerRunId } from "@sdk";

export function enqueueViaCommon(data: Record<string, unknown>): { runId: QueueWorkerRunId } {
  return sdk.enqueueWorkerSync<Record<string, unknown>>({
    unitPath: "test.queue-worker.queue_worker.noop",
    data,
  });
}
