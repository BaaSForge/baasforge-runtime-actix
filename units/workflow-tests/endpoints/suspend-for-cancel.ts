import { workflow } from "@sdk";

export type Input = void;
export type Output = { received: string | null };
export type ResolveInput = { value?: string };

/**
 * Minimal suspend workflow for testing cancel endpoint.
 * Follows basic-promise.ts pattern: ctx.run step, then promise suspension.
 */
export default workflow({
  run: async (ctx) => {
    await ctx.run("init", async () => "ready");
    const answer = await ctx.promise<string>("gate").get();
    return { received: answer };
  },
  handlers: {
    resolve: async (ctx, input: { value?: string } | undefined) => {
      await ctx.promise<string>("gate").resolve(input?.value ?? "ok");
    },
  },
});
