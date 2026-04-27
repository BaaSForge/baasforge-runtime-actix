import { workflow, sdk, type WorkflowInstanceId } from "@sdk";

const CHILD = "test.wf.workflow.http-same-unit-path-runtime-isolation";

export type Input = { marker: string };
export type Output = { childInstanceId: WorkflowInstanceId };

export default workflow<Input, Output>(async (ctx, input) => {
  const started = await ctx.run("start-child", () =>
    sdk.startWorkflowSync<{ marker?: string }>({
      unitPath: CHILD,
      input: { marker: input.marker },
    }),
  );
  return { childInstanceId: started.instanceId };
});
