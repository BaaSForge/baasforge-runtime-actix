/**
 * @active WORKFLOW LLM PROMPT EXAMPLE
 *
 * @covers `sdk.callWorkflowAndWaitForOutputSync<Input, Output>({ unitPath, input })`
 * to durably call another workflow unit and block until it returns a result.
 *
 * @important Do not remove unless equivalent coverage is provided elsewhere in the prompt.
 */
import { workflow, sdk } from "@sdk";

export type Input = void;
export type Output = { called: true; doubled: number };

export default workflow<Input, Output>(async (ctx) => {
  void ctx;
  const result = sdk.callWorkflowAndWaitForOutputSync<{ n: number }, { doubled: number }>({
    unitPath: "test.wf.workflow.sdk-call-callee",
    input: { n: 2 },
  });
  return { called: true, doubled: result.doubled };
});
