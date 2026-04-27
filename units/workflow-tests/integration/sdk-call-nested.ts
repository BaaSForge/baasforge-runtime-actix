import { workflow, sdk } from "@sdk";

export type Input = void;
export type Output = { result: number };

export default workflow<Input, Output>(async (_ctx) => {
  const middle = sdk.callWorkflowAndWaitForOutputSync<{ n: number }, { value: number }>({
    unitPath: "test.wf.workflow.sdk-call-nested-middle",
    input: { n: 3 },
  });
  return { result: middle.value };
});
