import { workflow, sdk } from "@sdk";

const CHILD = "test.wf.workflow.http-same-path-wf-handler-isolation";

export type Input = void;
export type Output = { scopeFromHandler: string; unitPathFromHandler: string };

export default workflow<Input, Output>(async (ctx) => {
  const started = await ctx.run("start-child", () =>
    sdk.startWorkflowSync<Record<string, never>>({ unitPath: CHILD, input: {} }),
  );
  const read = await ctx.run("read-scope", () =>
    sdk.callWorkflowHandlerAndWaitForResultSync<
      Record<string, never>,
      { scope: string; unitPath: string }
    >({
      unitPath: CHILD,
      instanceId: started.instanceId,
      handler: "readScope",
      input: {},
    }),
  );
  await ctx.run("finish-child", () =>
    sdk.callWorkflowHandlerAndWaitForResultSync({
      unitPath: CHILD,
      instanceId: started.instanceId,
      handler: "finish",
      input: {},
    }),
  );
  return { scopeFromHandler: read.scope, unitPathFromHandler: read.unitPath };
});
