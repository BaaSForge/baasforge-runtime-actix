import { workflow, sdk } from "@sdk";

export default workflow(async (ctx) => {
  void ctx;
  const result = await sdk.call("test.wf.workflow.sdk-call-promise-callee", {});
  return { result };
});
