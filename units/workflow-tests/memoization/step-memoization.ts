import { workflow, sdk } from "@sdk";

type StepRecord = { name: string; ordinal: number; marker: string };

type Output = {
  steps: StepRecord[];
  instanceKey: string;
};

/**
 * Three named steps each "counts" forward and embeds a deterministic marker.
 * On replay / re-invocation of the same instance, completed steps must not
 * re-execute — external harness can pair this with a side-channel counter or
 * compare markers across runs.
 */
export default workflow<unknown, Output>(async (ctx) => {
  void sdk;

  const a = await ctx.run("memo-step-a", async () => ({
    name: "a",
    ordinal: 1,
    marker: ctx.rand.uuidv4(),
  }));

  const b = await ctx.run("memo-step-b", async () => ({
    name: "b",
    ordinal: a.ordinal + 1,
    marker: ctx.rand.uuidv4(),
  }));

  const c = await ctx.run("memo-step-c", async () => ({
    name: "c",
    ordinal: b.ordinal + 1,
    marker: ctx.rand.uuidv4(),
  }));

  return { steps: [a, b, c], instanceKey: ctx.key };
});
