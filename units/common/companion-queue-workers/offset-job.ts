import { queueWorker } from "@sdk";
import { withOffset } from "@units/test.common.common.offset";

export type JobData = { n: number };
export type JobResult = { result: number };

export default queueWorker<JobData, JobResult>(async (_ctx, data) => {
  return { result: withOffset(data.n) };
});
