import { workflow, sdk } from "@sdk";

export type Input = void;
export type Output = { timedOut: boolean; value: string | null };

/**
 * No resolver is invoked; `.get()` should yield `null` after the timeout.
 * Uses a short wall-clock timeout so the harness finishes quickly.
 */
export default workflow(async (ctx) => {
  const result = await ctx.promise<string>("never-resolved").get({
    timeout: { milliseconds: 150 },
  });

  return {
    timedOut: result === null,
    value: result,
  };
});
