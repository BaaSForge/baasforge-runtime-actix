import { queueWorker, sdk } from "@sdk";

export type Input = Record<string, never>;
export type Output = never;

export default queueWorker<Input, never>({
  metadata: {
    retry: { maxAttempts: 2 },
    deadLetter: { enabled: true },
  },
  async process(ctx, _data) {
    void sdk;
    throw new Error(`always fails attempt ${ctx.attempt}`);
  },
  async onDeadLetter(_ctx, _data, _error) {
    void sdk;
    throw new Error("dead letter handler itself blew up");
  },
});
