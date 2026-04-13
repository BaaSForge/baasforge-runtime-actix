import { workflow, sdk } from "@sdk";

/**
 * Intended for harness tests: stop the runtime after `entered-sleep` is durable,
 * restart, and ensure the timer wakes the workflow without re-executing
 * memoized steps before the sleep boundary.
 */
export default workflow(async (ctx) => {
  const boundary = await ctx.run("before-timer", async () => ({
    step: "before-timer",
    marker: ctx.rand.uuidv4(),
  }));

  await ctx.run("entered-sleep", async () => ({ entered: true }));

  await ctx.sleep("survive-restart", { seconds: 2 });

  const after = await ctx.run("after-timer", async () => ({
    step: "after-timer",
    continuedFrom: boundary.marker,
  }));

  return {
    survived: true,
    boundary,
    after,
  };
});
