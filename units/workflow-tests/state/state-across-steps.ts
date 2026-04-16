import { workflow, sdk } from "@sdk";

export type Input = unknown;
export type Output = { marker: string | null; ok: boolean };

/**
 * Writes workflow state in the first durable step and reads it back in a later step.
 */
export default workflow(async (ctx, _input) => {
  await ctx.run("step-1-set", async () => {
    ctx.set("marker", "from-step-1");
    return true;
  });

  await ctx.run("step-2-nop", async () => "middle");

  const marker = await ctx.run("step-3-get", async () => {
    return await ctx.get<string>("marker");
  });

  return { marker, ok: marker === "from-step-1" };
});
