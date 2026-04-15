import { workflow, sdk } from "@sdk";

export type Input = void;
export type Output = { before: number; callResult: number; after: number };

export default workflow<Input, Output>(async (ctx) => {
  const before = await ctx.run("before", async () => 10);
  const callRes = await sdk.call<{ doubled: number }>("test.wf.workflow.sdk-call-callee", { n: 5 });
  const after = await ctx.run("after", async () => callRes.doubled + before);
  return { before, callResult: callRes.doubled, after };
});
