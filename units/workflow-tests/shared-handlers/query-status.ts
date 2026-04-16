import { workflow, sdk } from "@sdk";

export type Input = void;
export type Output = { status: { phase: string; counter: number } | null; done: boolean };
export type StatusOutput = { phase: string; counter: number } | null;
export type ReleaseOutput = { ok: boolean };

/**
 * Shared handler `status` returns the latest workflow state snapshot for external queries.
 */
export default workflow({
  run: async (ctx, _input) => {
    ctx.set("status", { phase: "running", counter: 1 });
    await ctx.promise("stop").get({ timeout: { hours: 1 } });
    const status = await ctx.get<{ phase: string; counter: number }>("status");
    return { status, done: true };
  },
  handlers: {
    status: async (ctx) => {
      return (await ctx.get<{ phase: string; counter: number }>("status")) ?? null;
    },
    release: async (ctx) => {
      await ctx.promise("stop").resolve(undefined);
      return { ok: true };
    },
  },
});
