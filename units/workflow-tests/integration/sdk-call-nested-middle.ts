import { workflow, sdk } from "@sdk";

export type Input = { n: number };
export type Output = { value: number };

export default workflow<Input, Output>(async (_ctx, input) => {
  const n = input?.n ?? 0;
  const result = sdk.callWorkflowAndWaitForOutputSync<{ n: number }, { doubled: number }>({
    unitPath: "test.wf.workflow.sdk-call-callee",
    input: { n },
  });
  return { value: result.doubled + n };
});
