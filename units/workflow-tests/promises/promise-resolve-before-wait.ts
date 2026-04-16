import { workflow, sdk } from "@sdk";

export type Input = void;
export type Output = { immediate: boolean; value: string | null };

/**
 * Resolve the durable promise in the same invocation before awaiting `.get()`.
 * The waiter should return immediately with the resolved value (no extra suspend).
 */
export default workflow(async (ctx) => {
  const p = ctx.promise<string>("early");

  await p.resolve("resolved-first");

  const value = await p.get();

  return {
    immediate: true,
    value,
  };
});
