/**
 * @active WORKFLOW LLM PROMPT EXAMPLE
 *
 * @covers `sdk.startWorkflowSync<Input>({ unitPath, input })` for
 * fire-and-forget workflow launching (returns `{ instanceId }` immediately without waiting
 * for completion), and the `WorkflowInstanceId` type import.
 *
 * @important Do not remove unless equivalent coverage is provided elsewhere in the prompt.
 */
import { workflow, sdk, type WorkflowInstanceId } from "@sdk";

export type Input = void;
export type Output = { instanceId: WorkflowInstanceId; nonEmpty: boolean };

/**
 * sdk.startWorkflowSync is fire-and-forget:
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
