import { workflow } from "@sdk";

export type Input = unknown;
export type Output = { a: number; b: number; inUnitInterval: boolean };

/**
 * Random floats are sampled inside durable steps; each step's outputs should replay identically.
 */
export default workflow(async (ctx, _input) => {
  return await ctx.run("capture-random", async () => {
    const a = ctx.rand.random();
    const b = ctx.rand.random();
    return {
      a,
      b,
      inUnitInterval: a >= 0 && a < 1 && b >= 0 && b < 1,
    };
  });
});
