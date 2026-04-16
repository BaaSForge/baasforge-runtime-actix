import { workflow, sdk } from "@sdk";

export type Input = void;
export type Output = { approval: string | null };
export type ApproveInput = { token?: string };
export type ApproveOutput = { resolved: boolean };

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
