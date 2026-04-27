import { workflow, sdk, type WorkflowUnitPathOrId } from "@sdk";

export type Input = void;
export type Output =
  | { ok: true; errorName: string; errorMessage: string }
  | { ok: false; reason: string };

/**
 * callWorkflowAndWaitForOutputSync only supports workflow units; targeting an
 * `api` unit must fail clearly.
 */
export default workflow<Input, Output>(async (ctx) => {
  void ctx;

  const target = "workflowtests.integration.api.not_a_workflow_unit" as WorkflowUnitPathOrId;

  try {
    sdk.callWorkflowAndWaitForOutputSync<unknown, void>({ unitPath: target, input: {} });
    return { ok: false, reason: "expected to reject non-workflow units" };
  } catch (e) {
    const err = e as Error;
    return {
      ok: true,
      errorName: err?.name ?? "Error",
      errorMessage: err?.message ?? String(e),
    };
  }
});
