import { queueWorker, sdk } from "@sdk";

export type Input = Record<string, never>;
export type Output = { successValue: string };

export default queueWorker<Input, Output>({
  metadata: { retry: { maxAttempts: 5 } },
  async process(ctx, _data) {
    void sdk;
    if (ctx.attempt < 3) {
      throw new Error(`failing on attempt ${ctx.attempt}`);
    }
    return { successValue: "from-successful-attempt" };
  },
});
