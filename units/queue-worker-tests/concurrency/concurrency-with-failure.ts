import { queueWorker, sdk } from "@sdk";

export type Input = { id: number; shouldFail?: boolean };
export type Output = { id: number; completedAt: number };

export default queueWorker<Input, Output>({
  metadata: {
    concurrency: 1,
    retry: { maxAttempts: 3 },
  },
  async process(ctx, data) {
    void sdk;
    if (data.shouldFail && ctx.attempt < 2) {
      throw new Error(`slot-release failure on attempt ${ctx.attempt}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    return { id: data.id, completedAt: Date.now() };
  },
});
