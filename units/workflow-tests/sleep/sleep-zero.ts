import { workflow, sdk } from "@sdk";

/** Edge case: zero duration should schedule and complete without meaningful delay. */
export default workflow(async (ctx) => {
  const before = await ctx.run("t0", async () => ctx.date.now());

  await ctx.sleep("zero-ms-number", 0);
  await ctx.sleep("zero-duration-obj", { milliseconds: 0 });

  const after = await ctx.run("t1", async () => ctx.date.now());

  return {
    edgeCase: "sleep-zero",
    before,
    after,
    deltaMs: after - before,
  };
});
