import { workflow, sdk } from "@sdk";

export type Input = void;
export type Output =
  | { ok: true; errorMessage: string }
  | { ok: false; reason: string };

/**
 * sdk.callWorkflow must reject paths that are not in context.module.unitType.name form.
 * This validation runs before any NATS publish, so it works without Phase C.
 */
export default workflow<Input, Output>(async (ctx) => {
  void ctx;

  try {
    await sdk.callWorkflow<void>("bad-path", {});
    return { ok: false, reason: "expected sdk.callWorkflow to reject invalid path" };
  } catch (e) {
    const err = e as Error;
    return { ok: true, errorMessage: err?.message ?? String(e) };
  }
});
