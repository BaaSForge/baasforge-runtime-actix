import { workflow, sdk } from "@sdk";

export type Input = void;
export type Output =
  | { ok: true; errorMessage: string }
  | { ok: false; reason: string };

/**
 * callWorkflowAndWaitForOutputSync must reject paths that are not in
 * context.module.unitType.name form.
 */
export default workflow<Input, Output>(async (ctx) => {
  void ctx;

  try {
    sdk.callWorkflowAndWaitForOutputSync<unknown, void>("bad-path", {});
    return { ok: false, reason: "expected to reject invalid path" };
  } catch (e) {
    const err = e as Error;
    return { ok: true, errorMessage: err?.message ?? String(e) };
  }
});
