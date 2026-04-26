import { actor, sdk } from "@sdk";

const CHILD = "test.wf.workflow.http-same-path-wf-handler-isolation";

type St = Record<string, never>;

export default actor<St>({
  state: {},
  handlers: {
    runHandlerProbe(_ctx): { scopeFromHandler: string; unitPathFromHandler: string } {
      const { instanceId } = sdk.startWorkflowSync<Record<string, never>>(CHILD, {});
      const read = sdk.callWorkflowHandlerAndWaitForResultSync<
        Record<string, never>,
        { scope: string; unitPath: string }
      >(CHILD, instanceId, "readScope", {});
      sdk.callWorkflowHandlerAndWaitForResultSync(CHILD, instanceId, "finish", {});
      return { scopeFromHandler: read.scope, unitPathFromHandler: read.unitPath };
    },
  },
});
