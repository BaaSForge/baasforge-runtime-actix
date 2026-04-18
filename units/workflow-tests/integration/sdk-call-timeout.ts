import { workflow, sdk } from "@sdk";

export type Input = void;
export type Output = { result: unknown };

export default workflow<Input, Output>(async (ctx) => {
  void ctx;
  const result = sdk.callWorkflowAndWaitForOutputSync<{ n: number }, unknown>(
    "test.wf.workflow.sdk-call-sleeping-callee", { n: 1 },
  );
  return { result };
});
