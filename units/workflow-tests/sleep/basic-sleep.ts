/**
 * @active WORKFLOW LLM PROMPT EXAMPLE
 *
 * @covers all `ctx.sleep` duration forms (raw millisecond number,
 * `{ milliseconds }`, `{ seconds }`, mixed `{ minutes, seconds, milliseconds }` object),
 * and `ctx.date.now()` inside a durable step for stable timestamps.
 *
 * @important Do not remove unless equivalent coverage is provided elsewhere in the prompt.
 */
import { workflow, sdk } from "@sdk";

export type Input = void;
export type Output = { ok: boolean; startedAt: number; endedAt: number; slept: string[] };

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
