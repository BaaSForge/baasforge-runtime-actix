/**
 * @active QUEUE WORKER LLM PROMPT EXAMPLE
 *
 * @covers worker → workflow: `startWorkflowSync`, `callWorkflowHandlerAndWaitForResultSync` (typed
 * read + untyped finish), reusing `instanceId` across calls on the child workflow.
 *
 * @important Do not remove unless equivalent coverage is provided elsewhere in the prompt.
 */
import { queueWorker, sdk } from "@sdk";

const CHILD = "test.wf.workflow.http-same-path-wf-handler-isolation";

export default queueWorker<Record<string, never>, { scopeFromHandler: string; unitPathFromHandler: string }>(
  async (_ctx) => {
    const { instanceId } = sdk.startWorkflowSync<Record<string, never>>({
      unitPath: CHILD,
      input: {},
    });
    const read = sdk.callWorkflowHandlerAndWaitForResultSync<
      Record<string, never>,
      { scope: string; unitPath: string }
    >({
      unitPath: CHILD,
      instanceId,
      handler: "readScope",
      input: {},
    });
    sdk.callWorkflowHandlerAndWaitForResultSync({
      unitPath: CHILD,
      instanceId,
      handler: "finish",
      input: {},
    });
    return { scopeFromHandler: read.scope, unitPathFromHandler: read.unitPath };
  },
);
