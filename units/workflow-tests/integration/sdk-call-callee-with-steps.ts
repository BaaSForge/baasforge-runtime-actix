import { workflow } from "@sdk";

export type Input = { n: number };
export type Output = { step1: number; step2: number };

export default workflow<Input, Output>(async (ctx, input) => {
  const n = input?.n ?? 0;
  const step1 = await ctx.run("increment", async () => n + 1);
  const step2 = await ctx.run("double-incremented", async () => step1 * 2);
  return { step1, step2 };
});
