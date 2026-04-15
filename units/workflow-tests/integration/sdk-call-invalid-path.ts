import { workflow, sdk } from "@sdk";

export type Input = void;
export type Output =
  | { ok: true; errorMessage: string }
  | { ok: false; reason: string };

/**
 * sdk.call must reject paths that are not in context.module.unitType.name form.
 * This validation runs before any NATS publish, so it works without Phase C.
 */
export default workflow<Input, Output>(async (ctx) => {
  void ctx;

  try {
    await sdk.call("bad-path", {});
    return { ok: false, reason: "expected sdk.call to reject invalid path" };
  } catch (e) {
    const err = e as Error;
    return { ok: true, errorMessage: err?.message ?? String(e) };
  }
});
