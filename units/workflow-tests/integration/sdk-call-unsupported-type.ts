import { workflow, sdk } from "@sdk";

export type Input = void;
export type Output =
  | { ok: true; errorName: string; errorMessage: string }
  | { ok: false; reason: string };

/**
 * sdk.callWorkflow only supports workflow units; targeting an `api` unit must fail clearly.
 */
export default workflow<Input, Output>(async (ctx) => {
  void ctx;

  const target = "workflowtests.integration.api.not_a_workflow_unit";

  try {
    await sdk.callWorkflow<void>(target, {});
    return { ok: false, reason: "expected sdk.callWorkflow to reject non-workflow units" };
  } catch (e) {
    const err = e as Error;
    return {
      ok: true,
      errorName: err?.name ?? "Error",
      errorMessage: err?.message ?? String(e),
    };
  }
});
