import { workflow, sdk } from "@sdk";

const CHILD = "test.wf.workflow.http-same-path-wf-handler-isolation";

export type Input = void;
export type Output = { scopeFromHandler: string; unitPathFromHandler: string };

export default workflow<Input, Output>(async (ctx) => {
  const started = await ctx.run("start-child", () => sdk.startWorkflowSync<Record<string, never>>(CHILD, {}));
  const read = await ctx.run("read-scope", () =>
    sdk.callWorkflowHandlerAndWaitForResultSync<
      Record<string, never>,
      { scope: string; unitPath: string }
    >(CHILD, started.instanceId, "readScope", {}),
  );
  await ctx.run("finish-child", () =>
    sdk.callWorkflowHandlerAndWaitForResultSync(CHILD, started.instanceId, "finish", {}),
  );
  return { scopeFromHandler: read.scope, unitPathFromHandler: read.unitPath };
});
