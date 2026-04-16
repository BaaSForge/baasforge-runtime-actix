import { workflow, sdk } from "@sdk";

export type Input = void;
export type Output = {
  steps: Array<{ index: number; v: string }>;
  postSleep: { firstIndex: number; lastIndex: number; count: number };
  allIndicesCorrect: boolean;
};

export default workflow<Input, Output>(async (ctx) => {
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
