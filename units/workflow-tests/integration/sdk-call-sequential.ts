import { workflow, sdk } from "@sdk";

export type Input = void;
export type Output = { first: number; second: number };

/**
 * Makes two sequential sdk.call invocations to verify the call-index counter
 * (sdk_call_0, sdk_call_1) works correctly for multiple calls in one workflow.
 *
 * On replay:
 *   - sdk_call_0 → cached in wfCtx.__promises["sdk_call_0"] → returns first result
 *   - sdk_call_1 → cached in wfCtx.__promises["sdk_call_1"] → returns second result
 *   Neither call re-invokes __baal_start_call on replay.
 *
 * REQUIRES Phase C (.start consumer in workflow_worker).
 * Test is registered but skipped until Phase C is complete.
 */
export default workflow<Input, Output>(async (ctx) => {
  void ctx;
  const a = await sdk.call("test.wf.workflow.sdk-call-callee", { n: 3 });
  const b = await sdk.call("test.wf.workflow.sdk-call-callee", { n: 5 });
  return { first: a?.doubled, second: b?.doubled };
});
