import { workflow, sdk, type WorkflowInstanceId } from "@sdk";

export type Input = void;
export type Output = { instanceId: WorkflowInstanceId; nonEmpty: boolean };

/**
 * Verifies sdk.startWorkflowSync is fire-and-forget:
 * returns { instanceId } immediately without waiting for the callee to finish.
 * The callee workflow (sdk-call-callee) completes asynchronously; this
 * caller does not wait for it.
 */
export default workflow<Input, Output>(async (_ctx) => {
  const started = sdk.startWorkflowSync<{ n: number }>({
    unitPath: "test.wf.workflow.sdk-call-callee",
    input: { n: 9 },
  });
  return {
    instanceId: started.instanceId,
    nonEmpty: typeof started.instanceId === "string" && started.instanceId.length > 0,
  };
});
