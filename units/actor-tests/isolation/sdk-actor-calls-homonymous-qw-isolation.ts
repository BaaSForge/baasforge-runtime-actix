import { actor, sdk } from "@sdk";

const QW_PATH = "test.queue-worker.queue_worker.http-same-unit-path-runtime-isolation";

type St = Record<string, never>;

export default actor<St>({
  state: {},
  handlers: {
    probeHomonymousQw(_ctx, input: { marker: string }): { enqueuedRunId: string; marker: string } {
      const { runId } = sdk.enqueueWorkerSync<{ marker: string }>(QW_PATH, { marker: input.marker });
      return { enqueuedRunId: runId, marker: input.marker };
    },
  },
});
