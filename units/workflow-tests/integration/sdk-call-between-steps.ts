import { workflow, sdk } from "@sdk";

export type Input = void;
export type Output = { before: number; callResult: number; after: number };

export default workflow<Input, Output>(async (ctx) => {
  const before = await ctx.run("before", () => 10);
  const callRes = sdk.callWorkflowAndWaitForOutputSync<{ n: number }, { doubled: number }>({
    unitPath: "test.wf.workflow.sdk-call-callee",
    input: { n: 5 },
  });
  const after = await ctx.run("after", () => callRes.doubled + before);
  return { before, callResult: callRes.doubled, after };
});
