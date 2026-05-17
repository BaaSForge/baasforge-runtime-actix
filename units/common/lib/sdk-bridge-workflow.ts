import { sdk } from "@sdk";

export function echoViaCommon(value: unknown): { echoed: unknown } {
  return sdk.callWorkflowAndWaitForOutputSync<{ value: unknown }, { echoed: unknown }>({
    unitPath: "test.wf.workflow.wf-echo",
    input: { value },
    opts: { timeoutMs: 120_000 },
  });
}
