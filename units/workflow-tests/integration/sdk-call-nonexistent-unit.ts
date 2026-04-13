import { workflow, sdk } from "@sdk";

export type Input = void;
export type Output =
  | { ok: true; errorMessage: string }
  | { ok: false; reason: string };

/**
 * Unknown unit path should surface a deterministic error to callers.
 */
export default workflow<Input, Output>(async (ctx) => {
  void ctx;

  const missing = "workflowtests.integration.workflow.__unit_does_not_exist__";

  try {
    await sdk.call(missing, { probe: true });
    return { ok: false, reason: "expected sdk.call to reject missing unit" };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: true, errorMessage: message };
  }
});
