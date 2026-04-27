import { workflow } from "@sdk";

export type Input = void;
export type Output = { received: string | null; complete: boolean };
export type ApproveInput = { value?: string };

export default workflow({
  run: async (ctx) => {
    await ctx.run("ready", async () => ({ waiting: true }));

    const answer = await ctx.promise<string>("external-approval").get();

    return {
      received: answer,
      complete: true,
    };
  },

  handlers: {
    approve: async (ctx, input: { value?: string } | undefined) => {
      await ctx.promise<string>("external-approval").resolve(input?.value ?? "approved");
    },
  },
});
