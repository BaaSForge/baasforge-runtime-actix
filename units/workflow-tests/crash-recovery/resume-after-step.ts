import { workflow, sdk } from "@sdk";

export type Input = void;
export type Output = {
  steps: [unknown, unknown, unknown];
  note: string;
};

/**
 * Numbered durable steps: after a crash following step 2, replay must return
 * cached results for steps 1–2 and only execute step 3’s body from the journal boundary.
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
