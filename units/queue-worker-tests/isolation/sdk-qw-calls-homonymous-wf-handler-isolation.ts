import { queueWorker, sdk } from "@sdk";

const CHILD = "test.wf.workflow.http-same-path-wf-handler-isolation";

export default queueWorker<Record<string, never>, { scopeFromHandler: string; unitPathFromHandler: string }>(
  async (_ctx) => {
    const { instanceId } = sdk.startWorkflowSync<Record<string, never>>(CHILD, {});
    const read = sdk.callWorkflowHandlerAndWaitForResultSync<
      Record<string, never>,
      { scope: string; unitPath: string }
    >(CHILD, instanceId, "readScope", {});
    sdk.callWorkflowHandlerAndWaitForResultSync(CHILD, instanceId, "finish", {});
    return { scopeFromHandler: read.scope, unitPathFromHandler: read.unitPath };
  },
);
