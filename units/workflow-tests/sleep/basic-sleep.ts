import { workflow, sdk } from "@sdk";

/**
 * Exercises ctx.sleep with millisecond numbers and Duration objects.
 * Harness asserts the workflow completes and returns the expected summary.
 */
export default workflow(async (ctx) => {
  const startedAt = await ctx.run("mark-start", async () => ctx.date.now());

  await ctx.sleep("sleep-ms-number", 50);
  await ctx.sleep("sleep-ms-obj", { milliseconds: 50 });
  await ctx.sleep("sleep-seconds", { seconds: 1 });
  await ctx.sleep("sleep-mixed", { minutes: 0, seconds: 0, milliseconds: 100 });

  const endedAt = await ctx.run("mark-end", async () => ctx.date.now());

  return {
    ok: true,
    startedAt,
    endedAt,
    slept: ["sleep-ms-number", "sleep-ms-obj", "sleep-seconds", "sleep-mixed"],
  };
});
