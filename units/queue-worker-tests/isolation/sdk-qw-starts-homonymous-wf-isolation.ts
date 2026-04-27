import { queueWorker, sdk, type WorkflowInstanceId } from "@sdk";

const WF_PATH = "test.wf.workflow.http-same-unit-path-runtime-isolation";

export default queueWorker<{ marker: string }, { childInstanceId: WorkflowInstanceId }>(async (_ctx, data) => {
  const { instanceId } = sdk.startWorkflowSync<{ marker?: string }>({
    unitPath: WF_PATH,
    input: { marker: data.marker },
  });
  return { childInstanceId: instanceId };
});
