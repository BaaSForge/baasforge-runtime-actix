import { workflow, sdk } from "@sdk";

/**
 * Entry workflow for A → B → C. Deploy companion workflows whose `run` handlers
 * continue the chain (B calls C). This unit only performs the first hop.
 */
const WORKFLOW_B = "workflowtests.integration.workflow.chain_workflow_b";

export type Input = { seed?: number };
export type Output = {
  hop: "A";
  downstream: { chain: string[]; leaf?: string };
};

export default workflow<Input, Output>(async (ctx, input) => {
  const downstream = await ctx.run("invoke-chain-b", async () =>
    sdk.call<{ chain: string[]; leaf?: string }>(WORKFLOW_B, {
      seed: input.seed ?? 0,
      chain: ["A"],
    }),
  );

  return { hop: "A", downstream };
});
