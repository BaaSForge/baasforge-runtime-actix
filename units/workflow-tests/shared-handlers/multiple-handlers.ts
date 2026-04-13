import { workflow, sdk } from "@sdk";

type Label = "first" | "second";

/**
 * Two named shared handlers each resolve a different durable promise observed sequentially in run.
 */
export default workflow({
  run: async (ctx, _input) => {
    const a = await ctx.promise<Label>("p-a").get({ timeout: { minutes: 10 } });
    const b = await ctx.promise<Label>("p-b").get({ timeout: { minutes: 10 } });
    return { order: [a, b] };
  },
  handlers: {
    resolveA: async (ctx) => {
      await ctx.promise<Label>("p-a").resolve("first");
      return { which: "a" };
    },
    resolveB: async (ctx) => {
      await ctx.promise<Label>("p-b").resolve("second");
      return { which: "b" };
    },
  },
});
