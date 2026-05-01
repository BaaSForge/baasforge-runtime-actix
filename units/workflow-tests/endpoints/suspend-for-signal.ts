/**
 * @active WORKFLOW LLM PROMPT EXAMPLE
 *
 * @covers `workflow({ run, handlers })` object form with multiple typed
 * handlers, `ctx.set`/`ctx.get` for durable state, `ctx.promise<T>("name").get({ timeout })`
 * for suspension, `ctx.promise<T>("name").resolve()` from a shared handler, and reading state
 * from within a handler
 *
 * @important Do not remove unless equivalent coverage is provided elsewhere in the prompt.
 */
import { workflow, sdk } from "@sdk";

export type Input = void;
export type Output = { phase: "done"; signal: unknown };
export type GetStateOutput = { phase: string | null; counter: number | null };
export type SignalInput = unknown;
export type SignalOutput = { accepted: boolean };

export default workflow({
  run: async (ctx, _input) => {
    ctx.set("phase", "waiting");
    ctx.set("counter", 42);
    const signal = await ctx.promise<unknown>("gate").get({ timeout: { hours: 24 } });
    return { phase: "done", signal };
  },
  handlers: {
    getState: async (ctx) => {
      return {
        phase: await ctx.get("phase"),
        counter: await ctx.get("counter"),
      };
    },
    signal: async (ctx, input?: any) => {
      await ctx.promise<unknown>("gate").resolve(input ?? "default");
      return { accepted: true };
    },
  },
});
