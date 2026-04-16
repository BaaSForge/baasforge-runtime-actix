import { workflow, sdk } from "@sdk";

export type Input = void;
export type Output = { calleeStep1: number; calleeStep2: number; combined: number };

export default workflow<Input, Output>(async (_ctx) => {
  const result = await sdk.callWorkflow<{ step1: number; step2: number }>(
    "test.wf.workflow.sdk-call-callee-with-steps",
    { n: 4 },
  );
  return {
    calleeStep1: result.step1,
    calleeStep2: result.step2,
    combined: result.step1 + result.step2,
  };
});
