import { workflow, sdk } from "@sdk";

export type Input = void;
export type Output = { reached: boolean };

export default workflow(async (ctx) => {
  void sdk;

  await ctx.run("mark-running", async () => ({ cancellable: true }));

  await ctx.sleep("long-sleep-cancel-target", { hours: 24 });

  return { reached: true };
});
