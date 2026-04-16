import { workflow, sdk } from "@sdk";

export default workflow(async (ctx) => {
  void ctx;
  const result = await sdk.callWorkflow("test.wf.workflow.sdk-call-promise-callee", {});
  return { result };
});
