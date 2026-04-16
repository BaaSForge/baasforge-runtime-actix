import { queueWorker, sdk } from "@sdk";

export type Input = { enqueuedAt: number };
export type Output = { processedAt: number; delayMs: number };

export default queueWorker<Input, Output>(async (_ctx, data) => {
  void sdk;
  const processedAt = Date.now();
  return { processedAt, delayMs: processedAt - data.enqueuedAt };
});
