import { workflow, sdk } from "@sdk";

export type Input = Record<string, never>;

export type Output = {
  message: string;
  /** Total durable attempts recorded for the flaky step (including successes) */
  attempts: number;
};

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
