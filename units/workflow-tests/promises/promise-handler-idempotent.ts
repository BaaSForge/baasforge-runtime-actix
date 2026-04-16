import { workflow, sdk } from "@sdk";

export type Input = void;
export type Output = { value: string | null; done: boolean };
export type ResolveInput = { value?: string };

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
