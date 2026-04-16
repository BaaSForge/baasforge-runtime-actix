import { queueWorker, sdk } from "@sdk";

export type Input = { secret: string; value: number };
export type Output = { dataOnFinalAttempt: Input; attempt: number };

export default queueWorker<Input, Output>({
  metadata: { retry: { maxAttempts: 5 } },
  async process(ctx, data) {
    void sdk;
    if (ctx.attempt < 3) {
      throw new Error(`failing on attempt ${ctx.attempt}`);
    }
    return { dataOnFinalAttempt: data, attempt: ctx.attempt };
  },
});
