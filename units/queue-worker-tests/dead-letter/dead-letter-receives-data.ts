import { queueWorker, sdk } from "@sdk";

export type Input = { originalValue: string };
export type Output = never;

export default queueWorker<Input>({
  metadata: {
    retry: { maxAttempts: 2 },
    deadLetter: { enabled: true },
  },
  async process(ctx, _data) {
    void sdk;
    throw new Error(`failing on attempt ${ctx.attempt}`);
  },
  async onDeadLetter(_ctx, data, _error) {
    void sdk;
    void data.originalValue;
  },
});
