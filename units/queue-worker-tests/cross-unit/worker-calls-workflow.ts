import { queueWorker, sdk } from "@sdk";

export type Input = { n: number };
export type Output = { n: number; doubled: number; workerDone: true };

export default queueWorker<Input, Output>(async (_ctx, data) => {
  const result = await sdk.callWorkflow<{ n: number; doubled: number }>(
    "test.wf.workflow.echo-workflow",
    { n: data.n },
  );
  return { n: result.n, doubled: result.doubled, workerDone: true };
});
