import { workflow, sdk } from "@sdk";

export type Input = void;
export type Output = { called: true; doubled: number };

/**
 * Caller workflow: invokes sdk-call-callee and returns its result.
 * Happy-path test for durable callWorkflowAndWaitForOutputSync suspension.
 */
export default workflow<Input, Output>(async (ctx) => {
  void ctx;
  const result = sdk.callWorkflowAndWaitForOutputSync<{ n: number }, { doubled: number }>(
    "test.wf.workflow.sdk-call-callee", { n: 2 },
  );
  return { called: true, doubled: result.doubled };
});
