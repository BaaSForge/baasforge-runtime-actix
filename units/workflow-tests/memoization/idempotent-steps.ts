import { workflow, sdk } from "@sdk";

type Output = {
  first: { id: number; note: string };
  second: { id: number; note: string };
  /** True when the runtime served the cached first result for the duplicate name */
  valuesMatch: boolean;
};

/**
 * Registers the same step name twice with different bodies. A correct memoization
 * implementation returns the cached value from the first execution for the second
 * call — `valuesMatch` should be true and `second` should not reflect the
 * alternate payload.
 */
export default workflow<unknown, Output>(async (ctx) => {
  void sdk;

  const first = await ctx.run("shared-step-name", async () => ({
    id: 1,
    note: "first-execution",
  }));

  const second = await ctx.run("shared-step-name", async () => ({
    id: 2,
    note: "second-execution-should-not-run",
  }));

  return {
    first,
    second,
    valuesMatch: first.id === second.id && first.note === second.note,
  };
});
