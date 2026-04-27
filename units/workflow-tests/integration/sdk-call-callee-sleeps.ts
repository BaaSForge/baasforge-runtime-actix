import { workflow, sdk } from "@sdk";

export type Input = void;
export type Output = { callResult: { n_doubled: number; slept: boolean }; callerDone: boolean };

export default workflow<Input, Output>(async (ctx) => {
  void ctx;
  const callResult = sdk.callWorkflowAndWaitForOutputSync<
    { n: number }, { n_doubled: number; slept: boolean }
  >({
    unitPath: "test.wf.workflow.sdk-call-sleeping-callee",
    input: { n: 5 },
  });
  return { callResult, callerDone: true };
});
