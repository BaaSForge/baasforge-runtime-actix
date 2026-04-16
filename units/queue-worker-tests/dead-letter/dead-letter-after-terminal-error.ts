import { queueWorker, sdk } from "@sdk";

export type Input = Record<string, never>;

export default queueWorker<Input>({
  metadata: {
    retry: { maxAttempts: 10 },
    deadLetter: { enabled: true },
  },
  async process(ctx, _data) {
    void sdk;
    throw new ctx.TerminalError("terminal: skip retries directly to dead letter");
  },
  async onDeadLetter(_ctx, _data, _error) {
    void sdk;
  },
});
