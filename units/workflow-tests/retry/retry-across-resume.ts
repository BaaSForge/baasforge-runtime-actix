import { workflow, sdk } from "@sdk";

export type Input = void;
export type Output = { attempts: number; succeeded: boolean };

export default workflow(async (ctx) => {
  void sdk;

  const result = await ctx.run(
    "flaky-step-with-backoff",
    async () => {
      const prev = Number((await ctx.get("retry-count")) ?? 0);
      const next = prev + 1;
      ctx.set("retry-count", next);
      if (next < 3) {
        throw new Error(`transient failure on attempt ${next}`);
      }
      return { attempts: next, succeeded: true };
    },
    {
      retryPolicy: {
        maxAttempts: 5,
        initialInterval: { milliseconds: 50 },
        backoffFactor: 2,
      },
    },
  );

  return {
    attempts: result.attempts,
    succeeded: result.succeeded,
  };
});
