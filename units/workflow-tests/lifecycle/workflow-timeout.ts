import { workflow, sdk } from "@sdk";

export type Input = void;
export type Output = { unreachable: true };

/**
 * Overall workflow run budget is enforced by the platform. This workflow intentionally
 * exceeds typical limits so the harness observes timeout/abort instead of completion.
 */
export default workflow<Input, Output>(async (ctx) => {
  void sdk;

  await ctx.run("start-long-work", async () => ({ phase: "before-sleep" }));

  await ctx.sleep("exceeds-run-budget", { days: 7 });

  return { unreachable: true };
});
