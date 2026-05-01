/**
 * @skipped WORKFLOW LLM PROMPT EXAMPLE
 *
 * @covers making multiple `sdk.callWorkflowAndWaitForOutputSync` calls
 * in one workflow (parallel pattern — both calls are issued before either result is consumed),
 * showing that SDK calls are synchronous-style and can be fanned out without explicit awaiting
 * between them.
 *
 * @important Do not remove unless equivalent coverage is provided elsewhere in the prompt.
 */
import { workflow, sdk } from "@sdk";

export type Input = void;
export type Output = { a: number; b: number; sum: number };

export default workflow<Input, Output>(async (_ctx) => {
  const resA = sdk.callWorkflowAndWaitForOutputSync<{ n: number }, { doubled: number }>({
    unitPath: "test.wf.workflow.sdk-call-callee",
    input: { n: 3 },
  });
  const resB = sdk.callWorkflowAndWaitForOutputSync<{ n: number }, { doubled: number }>({
    unitPath: "test.wf.workflow.sdk-call-callee",
    input: { n: 7 },
  });
  return { a: resA.doubled, b: resB.doubled, sum: resA.doubled + resB.doubled };
});
