import { workflow, sdk } from "@sdk";

export type Input = void;
export type Output = { a: number; b: number; sum: number };

export default workflow<Input, Output>(async (_ctx) => {
  const resA = sdk.callWorkflowAndWaitForOutputSync<{ n: number }, { doubled: number }>(
    "test.wf.workflow.sdk-call-callee", { n: 3 },
  );
  const resB = sdk.callWorkflowAndWaitForOutputSync<{ n: number }, { doubled: number }>(
    "test.wf.workflow.sdk-call-callee", { n: 7 },
  );
  return { a: resA.doubled, b: resB.doubled, sum: resA.doubled + resB.doubled };
});
