import { queueWorker, sdk } from "@sdk";

const WF_PATH = "test.wf.workflow.http-same-unit-path-runtime-isolation";

export default queueWorker<{ marker: string }, { childInstanceId: string }>(async (_ctx, data) => {
  const { instanceId } = sdk.startWorkflowSync<{ marker?: string }>(WF_PATH, { marker: data.marker });
  return { childInstanceId: instanceId };
});
