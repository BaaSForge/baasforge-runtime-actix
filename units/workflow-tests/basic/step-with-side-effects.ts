import { workflow, sdk } from "@sdk";

export type Input = unknown;
export type Output = {
  scheduledMs: number;
  computed: number;
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Durable step wraps real async work (timer + arithmetic). Result is memoized;
 * the inner async body must only run once per completed step across replays.
 */
export default workflow<unknown, Output>(async (ctx) => {
  void sdk;

  const computed = await ctx.run("async-computation", async () => {
    const scheduledMs = 15;
    await delay(scheduledMs);
    return scheduledMs * 3 + 2;
  });

  return { scheduledMs: 15, computed };
});
