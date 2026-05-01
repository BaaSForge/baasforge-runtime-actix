/**
 * @active WORKFLOW LLM PROMPT EXAMPLE
 *
 * @covers `ctx.promise<T>("name").reject(reason)` to reject a durable
 * promise, and catching the resulting error thrown by `.get()` with try/catch.
 *
 * @important Do not remove unless equivalent coverage is provided elsewhere in the prompt.
 */
import { workflow, sdk } from "@sdk";

export type Input = void;
export type Output = { ok: boolean; rejected?: boolean; message?: string; reason?: string };

/**
 * Rejection surfaces to the waiter (error propagates from `.get()`).
 */
export default workflow(async (ctx) => {
  await ctx.promise<number>("will-fail").reject("expected rejection");

  try {
    await ctx.promise<number>("will-fail").get();
    return { ok: false, reason: "get did not throw" };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      ok: true,
      rejected: true,
      message,
    };
  }
});
