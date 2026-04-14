import { workflow, sdk } from "@sdk";

/**
 * Intended for harness tests: stop the runtime after `entered-sleep` is durable,
 * restart, and ensure the timer wakes the workflow without re-executing
 * memoized steps before the sleep boundary.
 *
 * TODO(crash-sim): This test is a false positive. No restart is simulated — the
 * workflow idles through the 2 s sleep uninterrupted. `survived: true` is hardcoded
 * in the return value and `after.continuedFrom` is always set (it's just boundary.marker),
 * so all checks pass unconditionally. This test belongs in crash-recovery/, not sleep/.
 * Fix requires: killing the process after `entered-sleep` is persisted, restarting,
 * and verifying via a ctx.state execution counter that `before-timer` did not re-execute.
 */
export default workflow(async (ctx) => {
  const boundary = await ctx.run("before-timer", async () => ({
    step: "before-timer",
    marker: ctx.rand.uuidv4(),
  }));

  await ctx.run("entered-sleep", async () => ({ entered: true }));

  await ctx.sleep("survive-restart", { seconds: 2 });

  const after = await ctx.run("after-timer", async () => ({
    step: "after-timer",
    continuedFrom: boundary.marker,
  }));

  return {
    survived: true,
    boundary,
    after,
  };
});
