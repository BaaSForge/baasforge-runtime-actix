import { workflow } from "@sdk";

export type Input = { n: number };
export type Output = { n_doubled: number; slept: boolean };

export default workflow<Input, Output>(async (ctx, input) => {
  const n = input?.n ?? 0;

  await ctx.sleep("callee-sleep", { milliseconds: 100 });

  const n_doubled = await ctx.run("double", async () => n * 2);

  return { n_doubled, slept: true };
});
