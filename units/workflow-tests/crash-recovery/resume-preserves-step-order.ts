import { workflow, sdk } from "@sdk";

export type Input = void;
export type Output = {
  steps: Array<{ index: number; v: string; fromCache?: number[] }>;
  allInOrder: boolean;
  preSleepCached: number[];
};

export default workflow(async (ctx) => {
  void sdk;

  const s1 = await ctx.run("step-1", async () => ({ index: 1, v: ctx.rand.uuidv4() }));
  const s2 = await ctx.run("step-2", async () => ({ index: 2, v: ctx.rand.uuidv4() }));
  const s3 = await ctx.run("step-3", async () => ({ index: 3, v: ctx.rand.uuidv4() }));

  await ctx.sleep("mid-suspend", { milliseconds: 50 });

  const s4 = await ctx.run("step-4", async () => ({
    index: 4,
    v: ctx.rand.uuidv4(),
    fromCache: [s1.index, s2.index, s3.index],
  }));
  const s5 = await ctx.run("step-5", async () => ({ index: 5, v: ctx.rand.uuidv4() }));

  return {
    steps: [s1, s2, s3, s4, s5],
    allInOrder:
      s1.index < s2.index &&
      s2.index < s3.index &&
      s3.index < s4.index &&
      s4.index < s5.index,
    preSleepCached: s4.fromCache,
  };
});
