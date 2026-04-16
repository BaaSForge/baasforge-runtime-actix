import { workflow } from "@sdk";

export type Input = void;
export type Output = { token: string; sleptOk: boolean; attempts: number; result: string };

/**
 * Exercises both JetStream timer delivery paths in a single workflow:
 *
 *   1. `ctx.sleep` → publishes a JetStream message with `fire_at = now + delay`.
 *      The consumer NAKs with the remaining duration; the NATS server redelivers
 *      after the delay expires and the workflow resumes.
 *
 *   2. `ctx.run` with `retryPolicy` → each failed attempt publishes a JetStream
 *      message with `fire_at = now + backoffDelay`. The consumer NAKs and the
 *      NATS server redelivers, triggering the next attempt.
 *
 * The step deliberately fails on attempts 1 and 2, succeeds on 3. Combined
 * with the sleep, this verifies that both durable timer paths are independently
 * functional and can coexist in the same workflow instance.
 */
export default workflow(async (ctx) => {
  const token = await ctx.run("setup", async () => ctx.rand.uuidv4());

  // JetStream sleep-timer path
  await ctx.sleep("brief-pause", { milliseconds: 150 });

  // JetStream retry-timer path: fails on attempts 1 and 2, succeeds on 3
  const step = await ctx.run(
    "flaky-step",
    async () => {
      const prev = Number((await ctx.get("flaky-count")) ?? 0);
      const next = prev + 1;
      ctx.set("flaky-count", next);
      if (next < 3) {
        throw new Error(`transient on attempt ${next}`);
      }
      return { attempts: next, result: "done" };
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
    token,
    sleptOk: true,
    attempts: step.attempts,
    result: step.result,
  };
});
