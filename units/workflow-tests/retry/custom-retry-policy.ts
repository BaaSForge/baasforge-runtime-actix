import { workflow, sdk } from "@sdk";

export type Input = Record<string, never>;

export type Output = {
  ok: boolean;
  attempts: number;
};

export default workflow(async (ctx, _input: Input): Promise<Output> => {
  void sdk;

  const result = await ctx.run(
    "custom-backoff-step",
    async () => {
      const prev = Number((await ctx.get("policy-attempt")) ?? 0);
      const next = prev + 1;
      ctx.set("policy-attempt", next);
      if (next < 5) {
        throw new Error(`not yet: ${next}`);
      }
      return { ok: true, attempts: next };
    },
    {
      retryPolicy: {
        maxAttempts: 12,
        initialInterval: { milliseconds: 50 },
        backoffFactor: 3,
        maxInterval: { minutes: 1 },
      },
    },
  );

  return result;
});
