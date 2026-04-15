import { workflow, sdk } from "@sdk";

export type Input = void;
export type Output = { a: number; b: number; sum: number };

export default workflow<Input, Output>(async (_ctx) => {
  const [resA, resB] = await Promise.all([
    sdk.call<{ doubled: number }>("test.wf.workflow.sdk-call-callee", { n: 3 }),
    sdk.call<{ doubled: number }>("test.wf.workflow.sdk-call-callee", { n: 7 }),
  ]);
  const a = resA.doubled;
  const b = resB.doubled;
  return { a, b, sum: a + b };
});
