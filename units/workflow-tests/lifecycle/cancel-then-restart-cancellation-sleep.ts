import { workflow, sdk } from "@sdk";

export type Input = void;
export type Output = { phase: "scheduled-long-sleep" };

export default workflow<Input, Output>(async (ctx) => {
  void sdk;

  await ctx.run("mark-running", async () => ({ cancellable: true }));

  await ctx.sleep("wait-for-cancel", { hours: 24 });

  return { phase: "scheduled-long-sleep" };
});
