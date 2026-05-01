/**
 * @skipped QUEUE WORKER LLM PROMPT EXAMPLE
 *
 * @covers inbound workflow → queue worker: `enqueueWorkerSync` inside `ctx.run` (durable
 * side-effect placement). The suite entry is skipped until workflow-to-worker enqueue is wired
 * end-to-end.
 *
 * @important Do not remove unless equivalent coverage is provided elsewhere in the prompt.
 */
import { workflow, sdk } from "@sdk";

export type Input = { data: any };
export type Output = { runId: string; enqueued: true };

export default workflow<Input, Output>(async (ctx, input) => {
  const result = await ctx.run("enqueue-worker", () =>
    sdk.enqueueWorkerSync<{ payload: unknown }>({
      unitPath: "test.queue-worker.queue_worker.target-worker",
      data: { payload: input.data },
    }),
  );
  return { runId: result.runId, enqueued: true };
});
