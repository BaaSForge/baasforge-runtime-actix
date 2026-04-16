import { workflow, sdk } from "@sdk";

export default workflow(async (ctx) => {
  void ctx;
  const result = await sdk.callWorkflow("test.wf.workflow.sdk-call-sleeping-callee", { n: 1 });
  return { result };
});
