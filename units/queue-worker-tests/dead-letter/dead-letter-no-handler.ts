import { queueWorker, sdk } from "@sdk";

export type Input = Record<string, never>;
export type Output = never;

export default queueWorker<Input, never>({
  metadata: { retry: { maxAttempts: 2 } },
  async process(ctx, _data) {
    void sdk;
    throw new Error(`failing on attempt ${ctx.attempt}`);
  },
});
