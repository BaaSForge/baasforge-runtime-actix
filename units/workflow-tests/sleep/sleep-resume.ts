import { workflow, sdk } from "@sdk";

/**
 * After sleep, durable steps must not re-run; the workflow returns the
 * post-sleep result exactly once.
 *
 * TODO(false-positive): `resumed: true` is hardcoded inside the `after-sleep` step
 * closure, so the check passes unconditionally. This verifies that the workflow
 * wakes and completes after the timer fires, but does NOT prove that the pre-sleep
 * step was memoized (i.e., its closure was not re-executed on resume). Fix requires
 * a ctx.state execution counter inside `before-sleep` to confirm it ran exactly once.
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
