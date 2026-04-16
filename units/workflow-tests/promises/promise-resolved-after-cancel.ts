import { workflow, sdk } from "@sdk";

export default workflow({
  run: async (ctx) => {
    void sdk;

    await ctx.run("mark-waiting", async () => ({ waiting: true }));

    const value = await ctx.promise<string>("cancel-then-resolve-promise").get();

    return { reached: true, value };
  },

  handlers: {
    resolve: async (ctx, input: { value?: string }) => {
      await ctx.promise<string>("cancel-then-resolve-promise").resolve(
        input?.value ?? "resolved",
      );
    },
  },
});
