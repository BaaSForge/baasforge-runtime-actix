import { workflow, sdk } from "@sdk";

export type Input = void;
export type Output = { payload: { by: string; n: number } | null; finished: boolean };
export type PeekOutput = { payload: { by: string; n: number } | null };
export type FinishOutput = { ok: boolean };

/**
 * Run handler sets workflow state; shared handler reads it via ctx.get while run waits on a promise.
 */
export default workflow({
  run: async (ctx, _input) => {
    ctx.set("payload", { by: "run", n: 42 });
    await ctx.promise("done").get({ timeout: { minutes: 5 } });
    const payload = await ctx.get<{ by: string; n: number }>("payload");
    return { payload, finished: true };
  },
  handlers: {
    peek: async (ctx) => {
      const payload = await ctx.get<{ by: string; n: number }>("payload");
      return { payload };
    },
    finish: async (ctx) => {
      await ctx.promise("done").resolve(undefined);
      return { ok: true };
    },
  },
});
