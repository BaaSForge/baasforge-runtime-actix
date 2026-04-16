import { queueWorker, sdk } from "@sdk";

export type Input = Record<string, never>;

export default queueWorker<Input>({
  metadata: { retry: { maxAttempts: 2 } },
  async process(ctx, _data) {
    void sdk;
    throw new Error(`failing on attempt ${ctx.attempt}`);
  },
});
