import { workflow, sdk } from "@sdk";

export type Input = void;
export type Output = { first: number; second: number };

/**
 * Two sequential callWorkflowAndWaitForOutputSync invocations verify the
 * call-index counter (sdk_call_0, sdk_call_1) caches each suspension
 * independently on replay.
 */
export default workflow<Input, Output>(async (ctx) => {
  void ctx;
  const a = sdk.callWorkflowAndWaitForOutputSync<{ n: number }, { doubled: number }>({
    unitPath: "test.wf.workflow.sdk-call-callee",
    input: { n: 3 },
  });
  const b = sdk.callWorkflowAndWaitForOutputSync<{ n: number }, { doubled: number }>({
    unitPath: "test.wf.workflow.sdk-call-callee",
    input: { n: 5 },
  });
  return { first: a.doubled, second: b.doubled };
});
