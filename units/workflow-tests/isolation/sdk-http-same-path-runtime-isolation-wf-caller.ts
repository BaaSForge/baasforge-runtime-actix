import { workflow, sdk } from "@sdk";

export type Input = { marker: string };
export type Output = {
  childRuntimeScope: string;
  childUnitPath: string;
  childMarker: string | null;
};

export default workflow<Input, Output>(async (_ctx, input) => {
  const child = sdk.callWorkflowAndWaitForOutputSync<
    { marker?: string },
    { runtimeScope: string; unitPath: string; marker: string | null }
  >({
    unitPath: "test.wf.workflow.http-same-unit-path-runtime-isolation",
    input: { marker: input.marker },
  });
  return {
    childRuntimeScope: child.runtimeScope,
    childUnitPath: child.unitPath,
    childMarker: child.marker,
  };
});
