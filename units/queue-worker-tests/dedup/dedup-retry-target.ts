import { queueWorker, sdk } from "@sdk";

export type Input = { value: string };
export type Output = { value: string; attempt: number };

export default queueWorker<Input, Output>({
  metadata: { retry: { maxAttempts: 5, initialInterval: { seconds: 2 } } },
  async process(ctx, data) {
    void sdk;
    if (ctx.attempt < 3) {
      throw new Error(`failing to test dedup during retry (attempt ${ctx.attempt})`);
    }
    return { value: data.value, attempt: ctx.attempt };
  },
});
