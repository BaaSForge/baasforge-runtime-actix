import { queueWorker, sdk } from "@sdk";

export type Input = { marker: string };
export type Output = {
  wfDoubled: number;
  nestedRunId: string;
  marker: string;
};

export default queueWorker<Input, Output>(async (_ctx, data) => {
  const wf = sdk.callWorkflowAndWaitForOutputSync<{ n: number }, { n: number; doubled: number }>({
    unitPath: "test.wf.workflow.echo-workflow",
    input: { n: 7 },
  });
  const { runId } = sdk.enqueueWorkerSync<{ marker: string }>({
    unitPath: "test.queue-worker.queue_worker.runtime-isolation-qw-nested",
    data: { marker: data.marker },
  });
  return { wfDoubled: wf.doubled, nestedRunId: runId, marker: data.marker };
});
