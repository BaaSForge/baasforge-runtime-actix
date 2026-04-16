import { workflow, sdk } from "@sdk";

export type Input = { data: any };
export type Output = { runId: string; enqueued: true };

export default workflow<Input, Output>(async (ctx, input) => {
  const result = await ctx.run("enqueue-worker", () =>
    sdk.enqueueWorker("test.queue-worker.queue_worker.target-worker", { payload: input.data }),
  );
  return { runId: result.runId, enqueued: true };
});
