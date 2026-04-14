import { workflow, sdk } from "@sdk";

export type Input = Record<string, never>;

export type Output = {
  message: string;
  /** Total durable attempts recorded for the flaky step (including successes) */
  attempts: number;
};

// NOTE(ctx-set-in-failing-step): This test calls ctx.set inside a step closure
// that intentionally throws on the first two attempts. The retry counter only
// increments correctly if ctx.set writes persist even when the enclosing step
// closure throws — i.e., state writes are NOT rolled back on step failure.
// If the runtime makes state writes transactional with step success, the counter
// will never increment and the step will exhaust maxAttempts instead of succeeding
// on attempt 3.
export default workflow(async (ctx, _input: Input): Promise<Output> => {
  void sdk;

  const result = await ctx.run(
    "eventually-succeeds",
    async () => {
      const prev = Number((await ctx.get("flaky-attempt")) ?? 0);
      const next = prev + 1;
      ctx.set("flaky-attempt", next);
      if (next < 3) {
        throw new Error(`transient failure on attempt ${next}`);
      }
      return { message: "recovered", attempts: next };
    },
    { retryPolicy: { maxAttempts: 10 } },
  );

  return { message: result.message, attempts: result.attempts };
});
