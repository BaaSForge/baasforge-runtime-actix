import { workflow, sdk } from "@sdk";

export type Input = void;
export type Output = { slept: boolean; value: string | null };
export type ResolveInput = { value?: string };
export type ResolveOutput = { resolved: boolean };

export default workflow({
  run: async (ctx) => {
    void sdk;

    await ctx.sleep("sleep-before-promise", { milliseconds: 100 });

    const value = await ctx.promise<string>("post-sleep-promise").get();

    return { slept: true, value };
  },
  handlers: {
    resolve: async (ctx, input?: { value?: string }) => {
      await ctx.promise<string>("post-sleep-promise").resolve(input?.value ?? "");
      return { resolved: true };
    },
  },
});
