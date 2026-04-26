import { workflow, sdk } from "@sdk";

const CHILD = "test.wf.workflow.http-same-unit-path-runtime-isolation";

export type Input = { marker: string };
export type Output = { childInstanceId: string };

export default workflow<Input, Output>(async (ctx, input) => {
  const started = await ctx.run("start-child", () =>
    sdk.startWorkflowSync<{ marker?: string }>(CHILD, { marker: input.marker }),
  );
  return { childInstanceId: started.instanceId };
});
