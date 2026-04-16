import { queueWorker, sdk } from "@sdk";

export type Input = Record<string, never>;
export type Output = { attempt: number; ok: true };

export default queueWorker<Input, Output>({
  metadata: { retry: { maxAttempts: 3 } },
  async process(ctx, _data) {
    void sdk;
    if (ctx.attempt < 2) {
      throw new Error("simulating crash on first attempt");
    }
    return { attempt: ctx.attempt, ok: true };
  },
});
