import { queueWorker, sdk } from "@sdk";

export type Input = { item: string };
export type BatchOutput = { count: number; attempt: number };

export default queueWorker<Input[], BatchOutput>({
  metadata: {
    batch: { size: 3, timeout: "5s" },
    retry: { maxAttempts: 3 },
  },
  async process(ctx, items) {
    void sdk;
    if (ctx.attempt < 2) {
      throw new Error(`batch retry on attempt ${ctx.attempt}, batch size ${items.length}`);
    }
    return { count: items.length, attempt: ctx.attempt };
  },
});
