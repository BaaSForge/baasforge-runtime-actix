import { queueWorker, sdk } from "@sdk";

export type Input = { targetAttempt: number };
export type Output = { attempt: number };

export default queueWorker<Input, Output>({
  metadata: { retry: { maxAttempts: 10 } },
  async process(ctx, data) {
    void sdk;
    if (ctx.attempt < data.targetAttempt) {
      throw new Error(`not yet, attempt ${ctx.attempt}`);
    }
    return { attempt: ctx.attempt };
  },
});
