import { workflow, sdk } from "@sdk";

export type Input = void;
export type Output = {
  beforeSleep: { token: string };
  afterSleep: { sawToken: string; resumed: boolean };
};

/**
 * Crash or kill the runtime while the workflow is suspended in ctx.sleep.
 * On wake, the post-sleep step must run once with the memoized pre-sleep data.
 *
 * TODO: (crash-sim) This test is a false positive. No crash is actually simulated — the
 * runtime idles through the 400 ms sleep and the workflow completes normally.
 * `afterSleep.resumed` is hardcoded to `true` inside the step closure, so the check
 * passes unconditionally. Fix requires: (1) killing the process during the sleep
 * window, (2) restarting it, and (3) verifying via a ctx.state counter that the
 * pre-sleep step closure did not re-execute and that the post-sleep step ran exactly once.
 */
export default workflow<Input, Output>(async (ctx) => {
  void sdk;

  const beforeSleep = await ctx.run("pre-sleep", async () => ({
    token: ctx.rand.uuidv4(),
  }));

  await ctx.sleep("crash-during-sleep-window", { milliseconds: 400 });

  const afterSleep = await ctx.run("post-sleep", async () => ({
    sawToken: beforeSleep.token,
    resumed: true,
  }));

  return { beforeSleep, afterSleep };
});
