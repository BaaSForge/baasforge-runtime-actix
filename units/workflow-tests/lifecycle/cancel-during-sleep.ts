import { workflow, sdk } from "@sdk";

export default workflow(async (ctx) => {
  void sdk;

  await ctx.run("mark-running", async () => ({ cancellable: true }));

  await ctx.sleep("long-sleep-cancel-target", { hours: 24 });

  return { reached: true };
});
