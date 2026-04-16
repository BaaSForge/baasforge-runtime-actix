import { workflow, sdk } from "@sdk";

export type Input = void;
export type Output = { id: string; score: number };
export type SubmitResultInput = { id: string; score: number };
export type SubmitResultOutput = { accepted: boolean };
export type StatusOutput = { phase: string | null };

/**
 * Full workflow form: only shared handlers call `ctx.promise(...).resolve`,
 * mimicking HTTP callbacks or internal tools completing work out-of-band.
 */
export default workflow({
  run: async (ctx) => {
    ctx.set("phase", "waiting");

    const payload = await ctx.promise<{ id: string; score: number }>("shared-result").get({
      timeout: { hours: 24 },
    });

    if (!payload) {
      throw new ctx.TerminalError("Timed out waiting for shared handler");
    }

    ctx.set("phase", "done");

    return {
      id: payload.id,
      score: payload.score,
    };
  },

  handlers: {
    /**
     * Invoked by the test harness (or another unit) to unblock `run`.
     */
    submitResult: async (ctx, input: { id: string; score: number }) => {
      await ctx.promise<{ id: string; score: number }>("shared-result").resolve({
        id: input.id,
        score: input.score,
      });
      return { accepted: true };
    },

    /** Optional status probe for the harness. */
    status: async (ctx) => ({
      phase: await ctx.get<string>("phase"),
    }),
  },
});
