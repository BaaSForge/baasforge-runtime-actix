import { actor, sdk, type WorkflowInstanceId } from "@sdk";

const WF_PATH = "test.wf.workflow.http-same-unit-path-runtime-isolation";

type St = Record<string, never>;

export default actor<St>({
  state: {},
  handlers: {
    startHomonymousWf(_ctx, input: { marker: string }): { childInstanceId: WorkflowInstanceId } {
      const { instanceId } = sdk.startWorkflowSync<{ marker?: string }>({
        unitPath: WF_PATH,
        input: { marker: input.marker },
      });
      return { childInstanceId: instanceId };
    },
  },
});
