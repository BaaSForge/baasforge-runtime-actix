import { queueWorker, sdk } from "@sdk";

export type Input = Record<string, never>;
export type Output = { finalAttempt: number; ok: true };

export default queueWorker<Input, Output>({
  metadata: {
    retry: {
      maxAttempts: 5,
      initialInterval: { seconds: 1 },
      maxInterval: { minutes: 1 },
      backoffFactor: 2,
    },
  },
  async process(ctx, _data) {
    void sdk;
    if (ctx.attempt < 5) {
      throw new Error(`failing on attempt ${ctx.attempt}`);
    }
    return { finalAttempt: ctx.attempt, ok: true };
  },
});
