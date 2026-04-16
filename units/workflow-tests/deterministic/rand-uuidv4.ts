import { workflow } from "@sdk";

export type Input = unknown;
export type Output = { step1: string; step2: string; stepsAreDistinct: boolean };

/**
 * UUID is captured inside a named step so replay returns the memoized value (same id across replays).
 */
export default workflow(async (ctx, _input) => {
  const first = await ctx.run("uuid-once", async () => ctx.rand.uuidv4());
  const second = await ctx.run("uuid-step-2", async () => ctx.rand.uuidv4());
  return {
    step1: first,
    step2: second,
    stepsAreDistinct: first !== second,
  };
});
