import { queueWorker, sdk } from "@sdk";

export type Input = { runId: string };
export type Output = { processedRunId: string; processedAt: number };

export default queueWorker<Input, Output>(async (_ctx, data) => {
  void sdk;
  await new Promise((resolve) => setTimeout(resolve, 500));
  return { processedRunId: data.runId, processedAt: Date.now() };
});
