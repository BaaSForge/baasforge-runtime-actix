import { queueWorker, sdk } from "@sdk";

export type Input = Record<string, never>;
export type Output = { attempt: number; ok: true };

export default queueWorker<Input, Output>({
  metadata: {
    timeout: 500,
    retry: { maxAttempts: 3 },
  },
  async process(ctx, _data) {
    void sdk;
    if (ctx.attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    return { attempt: ctx.attempt, ok: true };
  },
});
