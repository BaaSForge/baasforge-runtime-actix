import { workflow, sdk } from "@sdk";

export type ApproveInput = { secret: string };
export type ApproveOutput = { accepted: boolean };

export type Input = void;
export type Output = {
  staged: { batch: string };
  approval: string | null;
  finalized: boolean;
};

/**
 * Suspend on a durable promise; crash while waiting. After resume, the external
 * approve handler resolves the promise and the final step completes exactly once.
 */
export default workflow<Input, Output>({
  run: async (ctx) => {
    void sdk;

    const staged = await ctx.run("step-before-wait", async () => ({
      batch: ctx.rand.uuidv4(),
    }));

    const approval = await ctx.promise<string>("manager-approval").get();

    const finalized = await ctx.run("step-after-approval", async () => ({
      batch: staged.batch,
      approval,
      sealed: true,
    }));

    return {
      staged,
      approval,
      finalized: finalized.sealed,
    };
  },

  handlers: {
    approve: async (ctx, req: ApproveInput): Promise<ApproveOutput> => {
      await ctx.promise("manager-approval").resolve(req.secret);
      return { accepted: true };
    },
  },
});
