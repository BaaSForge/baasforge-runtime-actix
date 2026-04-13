import { workflow, sdk } from "@sdk";

export type BumpOutput = { hits: number };
export type FinishInput = { value: string };
export type FinishOutput = { ok: true };

export type Input = void;
export type Output = { resolved: string };

/**
 * Shared handlers are invoked on dedicated HTTP routes while the run handler waits.
 * External test code calls /handler/... endpoints, then this workflow unblocks.
 */
export default workflow<Input, Output>({
  run: async (ctx) => {
    void sdk;

    await ctx.run("init", async () => {
      ctx.set("hits", 0);
      return null;
    });

    const resolved = await ctx.promise<string>("external-gate").get();

    return { resolved };
  },

  handlers: {
    bump: async (ctx): Promise<BumpOutput> => {
      const prev = (await ctx.get<number>("hits")) ?? 0;
      const next = prev + 1;
      ctx.set("hits", next);
      return { hits: next };
    },

    finish: async (ctx, req: FinishInput): Promise<FinishOutput> => {
      await ctx.promise("external-gate").resolve(req.value);
      return { ok: true };
    },
  },
});
