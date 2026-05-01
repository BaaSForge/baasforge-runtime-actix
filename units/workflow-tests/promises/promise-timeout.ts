/**
 * @active WORKFLOW LLM PROMPT EXAMPLE
 *
 * @covers `ctx.promise<T>("name").get({ timeout: { milliseconds } })`
 * returning `null` when no resolver fires within the deadline — the canonical way to model
 * an optional/time-bounded external signal.
 *
 * @important Do not remove unless equivalent coverage is provided elsewhere in the prompt.
 */
import { workflow, sdk } from "@sdk";

export type Input = void;
export type Output = { timedOut: boolean; value: string | null };

/**
 * No resolver is invoked; `.get()` yields `null` after the timeout.
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
