import { queueWorker, sdk } from "@sdk";

export type Input = Record<string, never>;
export type Output = { attempt: number; ok: true };

export default queueWorker<Input, Output>({
  metadata: {
    retry: { maxAttempts: 5, initialInterval: { seconds: 2 } },
  },
  async process(ctx, _data) {
    void sdk;
    if (ctx.attempt < 3) {
      throw new Error(`failing on attempt ${ctx.attempt}`);
    }
    return { attempt: ctx.attempt, ok: true };
  },
});
