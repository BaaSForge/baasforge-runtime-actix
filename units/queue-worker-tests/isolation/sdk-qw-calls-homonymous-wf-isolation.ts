import { queueWorker, sdk } from "@sdk";

const WF_PATH = "test.wf.workflow.http-same-unit-path-runtime-isolation";

export default queueWorker<
  { marker: string },
  { runtimeScope: string; unitPath: string; marker: string | null }
>(async (_ctx, data) => {
  return sdk.callWorkflowAndWaitForOutputSync<
    { marker?: string },
    { runtimeScope: string; unitPath: string; marker: string | null }
  >({
    unitPath: WF_PATH,
    input: { marker: data.marker },
  });
});
