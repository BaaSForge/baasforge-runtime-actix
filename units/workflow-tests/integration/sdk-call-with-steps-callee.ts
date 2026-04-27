import { workflow, sdk } from "@sdk";

export type Input = void;
export type Output = { calleeStep1: number; calleeStep2: number; combined: number };

export default workflow<Input, Output>(async (_ctx) => {
  const result = sdk.callWorkflowAndWaitForOutputSync<
    { n: number }, { step1: number; step2: number }
  >({
    unitPath: "test.wf.workflow.sdk-call-callee-with-steps",
    input: { n: 4 },
  });
  return {
    calleeStep1: result.step1,
    calleeStep2: result.step2,
    combined: result.step1 + result.step2,
  };
});
