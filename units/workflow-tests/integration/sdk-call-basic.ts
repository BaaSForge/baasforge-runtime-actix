import { workflow, sdk } from "@sdk";

export type Input = void;
export type Output = { called: true; doubled: number };

/**
 * Caller workflow: invokes sdk-call-callee via sdk.callWorkflow and returns its result.
 *
 * Happy-path test for durable sdk.callWorkflow suspension:
 *   1. Caller suspends on sdk_call_0 (durable promise).
 *   2. Worker picks up .start signal (Phase C), runs callee.
 *   3. workflow_engine resolves promise:sdk_call_0 on caller, publishes wake.
 *   4. Caller resumes, returns callee result.
 *
 * REQUIRES Phase C (.start consumer in workflow_worker).
 * Test is registered but skipped until Phase C is complete.
 */
export default workflow<Input, Output>(async (ctx) => {
  void ctx;
  const result = await sdk.callWorkflow("test.wf.workflow.sdk-call-callee", { n: 2 });
  return { called: true, doubled: result?.doubled };
});
