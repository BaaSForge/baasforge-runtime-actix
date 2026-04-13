import { workflow, sdk } from "@sdk";

/**
 * After sleep, durable steps must not re-run; the workflow returns the
 * post-sleep result exactly once.
 */
export default workflow(async (ctx) => {
  const pre = await ctx.run("before-sleep", async () => ({
    phase: "pre" as const,
    token: ctx.rand.uuidv4(),
  }));

  await ctx.sleep("short-wait", { milliseconds: 200 });

  const post = await ctx.run("after-sleep", async () => ({
    phase: "post" as const,
    sawPreToken: pre.token,
    resumed: true,
  }));

  return {
    prePhase: pre.phase,
    post,
    message: "completed-after-sleep",
  };
});
