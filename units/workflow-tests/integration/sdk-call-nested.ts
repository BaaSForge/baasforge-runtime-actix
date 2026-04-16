import { workflow, sdk } from "@sdk";

export type Input = void;
export type Output = { result: number };

export default workflow<Input, Output>(async (_ctx) => {
  const middle = await sdk.callWorkflow<{ value: number }>(
    "test.wf.workflow.sdk-call-nested-middle",
    { n: 3 },
  );
  return { result: middle.value };
});
