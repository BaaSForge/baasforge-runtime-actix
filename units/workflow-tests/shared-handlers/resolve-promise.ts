import { workflow, sdk } from "@sdk";

/**
 * Run waits on a durable promise; shared handler `approve` resolves it from outside the run handler.
 */
export default workflow({
  run: async (ctx, _input) => {
    const approval = await ctx.promise<string>("approval").get({ timeout: { hours: 24 } });
    return { approval };
  },
  handlers: {
    approve: async (ctx, input?: { token?: string }) => {
      await ctx.promise<string>("approval").resolve(input?.token ?? "approved");
      return { resolved: true };
    },
  },
});
