import { workflow } from "@sdk";

/**
 * Companion workflow for cross-unit harness tests.
 *
 * Input:  { value: unknown }
 * Output: { echoed: unknown }
 *
 * Does not sleep or wait on signals — safe to call with
 * `sdk.callWorkflowAndWaitForOutputSync`.
 */

export type Input = { value: unknown };
export type Output = { echoed: unknown };

export default workflow<Input, Output>({
  run: async (ctx, input) => {
    const result = await ctx.run("echo-step", () => ({ echoed: input.value }));
    return result;
  },
});
