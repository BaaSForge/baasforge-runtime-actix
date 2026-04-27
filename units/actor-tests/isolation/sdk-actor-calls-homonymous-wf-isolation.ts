import { actor, sdk } from "@sdk";

const WF_PATH = "test.wf.workflow.http-same-unit-path-runtime-isolation";

type St = Record<string, never>;

export default actor<St>({
  state: {},
  handlers: {
    probeHomonymousWf(_ctx, input: { marker: string }): {
      runtimeScope: string;
      unitPath: string;
      marker: string | null;
    } {
      return sdk.callWorkflowAndWaitForOutputSync<
        { marker?: string },
        { runtimeScope: string; unitPath: string; marker: string | null }
      >({
        unitPath: WF_PATH,
        input: { marker: input.marker },
      });
    },
  },
});
