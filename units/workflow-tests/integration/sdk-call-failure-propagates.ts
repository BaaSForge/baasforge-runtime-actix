import { workflow, sdk } from "@sdk";

export type Input = void;
export type Output =
  | { caught: true; errorMessage: string }
  | { caught: false; reason: string };

/**
 * Caller that invokes sdk-call-failing-callee.
 * Verifies that a callee failure rejects the caller's durable promise,
 * which means reject_caller_promise() in workflow_engine is exercised.
 *
 * REQUIRES Phase C (.start consumer in workflow_worker).
 * Test is registered but skipped until Phase C is complete.
 */
export default workflow<Input, Output>(async (ctx) => {
  void ctx;
  try {
    await sdk.callWorkflow<void>("test.wf.workflow.sdk-call-failing-callee", {});
    return { caught: false, reason: "expected sdk.callWorkflow to throw on callee failure" };
  } catch (e) {
    const err = e as Error;
    return { caught: true, errorMessage: err?.message ?? String(e) };
  }
});
