import { workflow, sdk } from "@sdk";

export type Input = void;
export type Output = { a: string; b: string; c: string; sequence: string[] };

export default workflow(async (ctx) => {
  void sdk;

  const a = await ctx.run("step-a", async () => "step-a");

  await ctx.sleep("first-sleep", { milliseconds: 50 });

  const b = await ctx.run("step-b", async () => "step-b");

  await ctx.sleep("second-sleep", { milliseconds: 50 });

  const c = await ctx.run("step-c", async () => "step-c");

  return { a, b, c, sequence: [a, b, c] };
});
