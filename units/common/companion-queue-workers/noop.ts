import { queueWorker } from "@sdk";

/**
 * No-op queue worker used as a companion for common cross-unit tests.
 *
 * Accepts any job data record and immediately returns `{ processed: true }`.
 * Used to verify that `sdk.enqueueWorkerSync` is accepted end-to-end.
 */

export type JobData = Record<string, unknown>;
export type JobResult = { processed: true };

export default queueWorker<JobData, JobResult>(async (_ctx, _data) => {
  return { processed: true };
});
