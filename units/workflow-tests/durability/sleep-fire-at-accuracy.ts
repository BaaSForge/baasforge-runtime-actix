import { workflow, sdk } from "@sdk";

export default workflow(async (ctx) => {
  void sdk;

  const t1 = await ctx.run("mark-before", async () => ctx.date.now());

  await ctx.sleep("measured-sleep", { milliseconds: 500 });

  const t2 = await ctx.run("mark-after", async () => ctx.date.now());

  const elapsed = t2 - t1;

  return {
    elapsed,
    withinTolerance: elapsed >= 300 && elapsed <= 5000,
  };
});
