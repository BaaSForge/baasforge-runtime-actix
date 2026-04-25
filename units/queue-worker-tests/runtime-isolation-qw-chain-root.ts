import { queueWorker, sdk } from "@sdk";

export type Input = { marker: string };
export type Output = {
  wfDoubled: number;
  nestedRunId: string;
  marker: string;
};

export default queueWorker<Input, Output>(async (_ctx, data) => {
  const wf = sdk.callWorkflowAndWaitForOutputSync<{ n: number }, { n: number; doubled: number }>(
    "test.wf.workflow.echo-workflow",
    { n: 7 },
  );
  const { runId } = sdk.enqueueWorkerSync<{ marker: string }>(
    "test.queue-worker.queue_worker.runtime-isolation-qw-nested",
    { marker: data.marker },
  );
  return { wfDoubled: wf.doubled, nestedRunId: runId, marker: data.marker };
});
