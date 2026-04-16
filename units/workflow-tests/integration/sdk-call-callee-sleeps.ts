import { workflow, sdk } from "@sdk";

export type Input = void;
export type Output = { callResult: { n_doubled: number; slept: boolean }; callerDone: boolean };

export default workflow<Input, Output>(async (ctx) => {
  void ctx;
  const callResult = await sdk.call<{ n_doubled: number; slept: boolean }>(
    "test.wf.workflow.sdk-call-sleeping-callee",
    { n: 5 },
  );
  return { callResult, callerDone: true };
});
