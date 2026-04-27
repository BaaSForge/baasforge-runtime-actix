import { workflow, sdk } from "@sdk";

export type Input = void;
export type Output = { result: unknown };

export default workflow<Input, Output>(async (ctx) => {
  void ctx;
  const result = sdk.callWorkflowAndWaitForOutputSync<{ n: number }, unknown>({
    unitPath: "test.wf.workflow.sdk-call-sleeping-callee",
    input: { n: 1 },
  });
  return { result };
});
