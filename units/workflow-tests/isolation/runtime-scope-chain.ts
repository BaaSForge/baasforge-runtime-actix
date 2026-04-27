import { workflow, sdk } from "@sdk";

export type Input = { marker: string };
export type Output = {
  workflowScope: string;
  marker: string;
};

export default workflow<Input, Output>(async (_ctx, input) => {
  const workflowResult = sdk.callWorkflowAndWaitForOutputSync<{ marker: string }, { runtimeScope: string }>({
    unitPath: "test.wf.workflow.runtime-scope-workflow-target",
    input: { marker: input.marker },
  });
  return {
    workflowScope: workflowResult.runtimeScope,
    marker: input.marker,
  };
});
