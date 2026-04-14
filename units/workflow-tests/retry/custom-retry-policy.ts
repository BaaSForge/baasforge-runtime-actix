import { workflow, sdk } from "@sdk";

export type Input = Record<string, never>;

export type Output = {
  ok: boolean;
  attempts: number;
};

// NOTE(ctx-set-in-failing-step): Same assumption as default-retry — ctx.set inside a
// throwing step closure must persist across retries for the attempt counter to reach 5.
// If state writes are transactional with step success the counter stays at 0 on every
// retry and the step never succeeds.
//
// NOTE(backoff-timing): The harness caps its inter-retry wait at 500 ms
// (`Math.min(delayMs + 100, 500)`). With backoffFactor=3 and initialInterval=50 ms,
// the 4th retry delay is 1 350 ms, so the harness polls early for that iteration.
// This is harmless — the 100-iteration poll loop provides enough total budget —
// but it means the harness is not accurately mirroring the declared backoff.
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
