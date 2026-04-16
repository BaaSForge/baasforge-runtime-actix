import { queueWorker, sdk } from "@sdk";

export type Input = Record<string, never>;
export type Output = { finalAttempt: number; ok: true };

export default queueWorker<Input, Output>({
  metadata: { retry: { maxAttempts: 5 } },
  async process(ctx, _data) {
    void sdk;
    if (ctx.attempt < 3) {
      throw new Error(`transient failure on attempt ${ctx.attempt}`);
    }
    return { finalAttempt: ctx.attempt, ok: true };
  },
});
