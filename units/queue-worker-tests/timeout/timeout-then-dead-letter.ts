import { queueWorker, sdk } from "@sdk";

export type Input = Record<string, never>;
export type Output = void;

export default queueWorker<Input, Output>({
  metadata: {
    timeout: 500,
    retry: { maxAttempts: 2 },
    deadLetter: { enabled: true },
  },
  async process(_ctx, _data) {
    void sdk;
    await new Promise((resolve) => setTimeout(resolve, 5000));
  },
  async onDeadLetter(_ctx, _data, _error) {
    void sdk;
  },
});
