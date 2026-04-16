import { workflow, sdk } from "@sdk";

export default workflow(async (ctx) => {
  void sdk;

  const steps: { index: number; v: string }[] = [];

  for (let i = 1; i <= 20; i++) {
    const s = await ctx.run(`step-${i}`, async () => ({
      index: i,
      v: ctx.rand.uuidv4(),
    }));
    steps.push(s);
  }

  await ctx.sleep("mid-suspend", { milliseconds: 50 });

  const postSleep = await ctx.run("post-sleep-verify", async () => ({
    firstIndex: steps[0]!.index,
    lastIndex: steps[steps.length - 1]!.index,
    count: steps.length,
  }));

  return {
    steps,
    postSleep,
    allIndicesCorrect: steps.every((s, i) => s.index === i + 1),
  };
});
