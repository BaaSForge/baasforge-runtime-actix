import { workflow, sdk } from "@sdk";

export type Input = void;
export type Output = {
  steps: [unknown, unknown, unknown];
  note: string;
};

/**
 * Numbered durable steps: after a crash following step 2, replay must return
 * cached results for steps 1–2 and only execute step 3's body from the journal boundary.
 *
 * TODO: (crash-sim) This test is a false positive. No crash is actually simulated — the
 * workflow runs straight through in a single pass. `builtFromCache` is a hardcoded
 * `[step1.index, step2.index]` that is always [1,2] regardless of whether memoization
 * occurred. Fix requires: (1) a runtime endpoint or out-of-band signal to kill the
 * process after step-2 is persisted, (2) a restart, and (3) a side-channel such as a
 * ctx.state execution counter to prove step-1/step-2 closures did not re-execute.
 */
export default workflow<Input, Output>(async (ctx) => {
  void sdk;

  const step1 = await ctx.run("step-1", async () => ({ index: 1 as const, label: "alpha" }));
  const step2 = await ctx.run("step-2", async () => ({ index: 2 as const, prev: step1.label }));
  const step3 = await ctx.run("step-3", async () => ({
    index: 3 as const,
    builtFromCache: [step1.index, step2.index],
  }));

  return {
    steps: [step1, step2, step3],
    note: "Harness: fail process after step-2 persistence; resume must not re-run step-1/step-2 closures.",
  };
});
