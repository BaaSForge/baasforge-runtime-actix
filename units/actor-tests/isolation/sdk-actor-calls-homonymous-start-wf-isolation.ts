import { actor, sdk } from "@sdk";

const WF_PATH = "test.wf.workflow.http-same-unit-path-runtime-isolation";

type St = Record<string, never>;

export default actor<St>({
  state: {},
  handlers: {
    startHomonymousWf(_ctx, input: { marker: string }): { childInstanceId: string } {
      const { instanceId } = sdk.startWorkflowSync<{ marker?: string }>(WF_PATH, { marker: input.marker });
      return { childInstanceId: instanceId };
    },
  },
});
