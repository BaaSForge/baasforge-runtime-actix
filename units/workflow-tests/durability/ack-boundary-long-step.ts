import { workflow, sdk } from "@sdk";

export type Input = void;
export type Output = { done: boolean; elapsed: number; exceededAckWait: boolean };

export default workflow(async (ctx) => {
  void sdk;

  const result = await ctx.run("long-compute", async () => {
    const start = Date.now();
    let iterations = 0;
    while (Date.now() - start < 35_000) {
      iterations++;
      if (iterations % 1_000_000 === 0) {
        Math.sqrt(iterations);
      }
    }
    return { iterations, elapsed: Date.now() - start };
  });

  return {
    done: true,
    elapsed: result.elapsed,
    exceededAckWait: result.elapsed > 30_000,
  };
});
