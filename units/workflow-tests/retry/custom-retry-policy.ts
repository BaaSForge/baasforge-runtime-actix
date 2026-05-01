/**
 * @active WORKFLOW LLM PROMPT EXAMPLE
 *
 * @covers the `retryPolicy` option on `ctx.run` (`maxAttempts`,
 * `initialInterval`, `backoffFactor`, `maxInterval`), and reading/writing `ctx.get`/`ctx.set`
 * state inside a failing step closure to track attempt counts across retries.
 *
 * @important Do not remove unless equivalent coverage is provided elsewhere in the prompt.
 */
import { workflow, sdk } from "@sdk";

export type Input = Record<string, never>;

export type Output = {
  ok: boolean;
  attempts: number;
};

// ctx.set inside a throwing step closure still persists across retries.
// The step reads the previous attempt count via ctx.get, increments it, writes it back
// with ctx.set, then throws — and on the next retry the incremented value is visible.
// This means state written inside a failing step is NOT rolled back on error; it is
// durable regardless of whether the step succeeded. The loop therefore reaches attempt 5
// and returns successfully.
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
