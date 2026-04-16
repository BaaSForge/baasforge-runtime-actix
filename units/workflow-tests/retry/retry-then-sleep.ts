import { workflow, sdk } from "@sdk";

export type Input = void;
export type Output = { attempts: number; slept: boolean; done: boolean };

export default workflow(async (ctx) => {
  void sdk;

  const retried = await ctx.run(
    "retried-step",
    async () => {
      const prev = Number((await ctx.get("retry-then-sleep-count")) ?? 0);
      const next = prev + 1;
      ctx.set("retry-then-sleep-count", next);
      if (next < 2) {
        throw new Error(`fail on attempt ${next}`);
      }
      return { attempts: next };
    },
    {
      retryPolicy: {
        maxAttempts: 3,
        initialInterval: { milliseconds: 50 },
      },
    },
  );

  await ctx.sleep("post-retry-sleep", { milliseconds: 100 });

  const final = await ctx.run("final-step", async () => ({ done: true }));

  return {
    attempts: retried.attempts,
    slept: true,
    done: final.done,
  };
});
