import { workflow, sdk } from "@sdk";

export type Input = void;
export type Output = { caught: boolean; errorMessage: string };

export default workflow<Input, Output>(async (_ctx) => {
  try {
    sdk.callWorkflowAndWaitForOutputSync<unknown, void>({
      unitPath: "test.wf.workflow.sdk-call-failing-after-steps",
      input: {},
    });
    return { caught: false, errorMessage: "" };
  } catch (e) {
    const err = e as Error;
    return { caught: true, errorMessage: err?.message ?? String(e) };
  }
});
