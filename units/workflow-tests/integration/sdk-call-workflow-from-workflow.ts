import { workflow, sdk } from "@sdk";

/** Deploy the callee workflow alongside this unit; path must match dashboard context.module.workflow.name */
const CALLEE = "workflowtests.integration.workflow.sdk_call_callee";

export type Input = { message?: string };
export type Output = {
  parentInstance: string;
  child: { echoed: string };
};

/**
 * Parent workflow invokes another workflow through sdk.call (workflow units only).
 */
export default workflow<Input, Output>(async (ctx, input) => {
  const child = await ctx.run("invoke-callee", async () =>
    sdk.call<{ echoed: string }>(CALLEE, { message: input.message ?? "from-parent" }),
  );

  return {
    parentInstance: ctx.key,
    child,
  };
});
