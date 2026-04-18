import { queueWorker, sdk } from "@sdk";

export type Input = { enqueuedAt: number };
export type Output = { attempt: number; processedAt: number };

export default queueWorker<Input, Output>({
  metadata: { retry: { maxAttempts: 3 } },
  async process(ctx, _data) {
    void sdk;
    if (ctx.attempt < 2) {
      throw new Error(`retry attempt ${ctx.attempt}`);
    }
    return { attempt: ctx.attempt, processedAt: Date.now() };
  },
});
