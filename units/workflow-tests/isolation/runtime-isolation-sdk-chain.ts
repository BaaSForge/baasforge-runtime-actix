import { workflow, sdk } from "@sdk";

export type Input = { marker?: string };
export type Output = {
  marker: string | null;
  midSelf: string;
  childScope: string;
};

export default workflow<Input, Output>(async (ctx, input) => {
  const mid = await ctx.run("mid", () =>
    sdk.callWorkflowAndWaitForOutputSync<
      { marker?: string },
      { midSelf: string; child: string; marker: string | null }
    >("test.wf.workflow.runtime-isolation-wf-chain-mid", {
      ...(input.marker === undefined ? {} : { marker: input.marker }),
    }),
  );
  return { marker: mid.marker, midSelf: mid.midSelf, childScope: mid.child };
});
