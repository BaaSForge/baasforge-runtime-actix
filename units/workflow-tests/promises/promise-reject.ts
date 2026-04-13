import { workflow, sdk } from "@sdk";

/**
 * Rejection must surface to the waiter (error propagates from `.get()`).
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
