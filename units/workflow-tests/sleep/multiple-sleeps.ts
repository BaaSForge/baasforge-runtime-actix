import { workflow, sdk } from "@sdk";

export type Input = void;
export type Output = { sequence: string[]; total: number; ok: boolean };

/** Several sequential sleeps in a single workflow instance (distinct step names). */
export default workflow(async (ctx) => {
  const sequence: string[] = [];

  await ctx.sleep("first", { milliseconds: 50 });
  sequence.push("first");

  await ctx.sleep("second", { milliseconds: 50 });
  sequence.push("second");

  await ctx.sleep("third", { milliseconds: 50 });
  sequence.push("third");

  const total = await ctx.run("count", async () => sequence.length);

  return { sequence, total, ok: total === 3 };
});
