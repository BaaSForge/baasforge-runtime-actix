import { workflow } from "@sdk";

/**
 * Timestamps are taken inside named steps so each boundary is stable on replay.
 */
export default workflow(async (ctx, _input) => {
  const t1 = await ctx.run("t1", async () => ctx.date.now());
  const t2 = await ctx.run("t2", async () => ctx.date.now());
  return {
    t1,
    t2,
    nonDecreasing: t2 >= t1,
  };
});
