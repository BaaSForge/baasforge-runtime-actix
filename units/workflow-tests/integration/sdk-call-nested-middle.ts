import { workflow, sdk } from "@sdk";

export type Input = { n: number };
export type Output = { value: number };

export default workflow<Input, Output>(async (_ctx, input) => {
  const n = input?.n ?? 0;
  const result = await sdk.callWorkflow<{ doubled: number }>("test.wf.workflow.sdk-call-callee", { n });
  return { value: result.doubled + n };
});
