import { workflow, sdk } from "@sdk";

export default workflow({
  run: async (ctx) => {
    void sdk;

    await ctx.run("ready", async () => ({ waiting: true }));

    const value = await ctx.promise<string>("idempotent-promise").get();

    return { value, done: true };
  },

  handlers: {
    resolve: async (ctx, input: { value?: string }) => {
      await ctx.promise<string>("idempotent-promise").resolve(input?.value ?? "resolved-once");
    },
  },
});
