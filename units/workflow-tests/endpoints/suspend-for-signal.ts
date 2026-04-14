import { workflow, sdk } from "@sdk";

/**
 * Suspend workflow with state and shared handlers for testing handler endpoints.
 * Follows query-status.ts pattern: ctx.set for state, promise for suspension,
 * separate handler names from promise name.
 */
export default workflow({
  run: async (ctx, _input) => {
    ctx.set("phase", "waiting");
    ctx.set("counter", 42);
    const signal = await ctx.promise("gate").get({ timeout: { hours: 24 } });
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
      await ctx.promise("gate").resolve(input ?? "default");
      return { accepted: true };
    },
  },
});
