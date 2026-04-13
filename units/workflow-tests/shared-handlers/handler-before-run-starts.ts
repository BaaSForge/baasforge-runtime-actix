import { workflow, sdk } from "@sdk";

/**
 * Run blocks on `go` at the very first await. Tests should call shared handler `allow` to unblock
 * before any durable `ctx.run` step executes — proving a shared handler can run before main body work.
 */
export default workflow({
  run: async (ctx, _input) => {
    await ctx.promise("go").get({ timeout: { hours: 1 } });
    return await ctx.run("after-gate", async () => {
      ctx.set("entered", true);
      return { phase: "main-work" };
    });
  },
  handlers: {
    allow: async (ctx) => {
      await ctx.promise("go").resolve(undefined);
      return { unblocked: true };
    },
  },
});
