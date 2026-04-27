import { workflow, sdk } from "@sdk";

export type Input = { marker?: string };
export type Output = { midSelf: "prod"; child: string; marker: string | null };

export default workflow<Input, Output>(async (ctx, input) => {
  const leaf = await ctx.run("leaf", () =>
    sdk.callWorkflowAndWaitForOutputSync<{ marker?: string }, { runtimeScope: string; marker: string | null }>({
      unitPath: "test.wf.workflow.runtime-isolation-wf-chain-leaf",
      input: {
        ...(input.marker === undefined ? {} : { marker: input.marker }),
      },
    }),
  );
  return { midSelf: "prod", child: leaf.runtimeScope, marker: leaf.marker };
});
