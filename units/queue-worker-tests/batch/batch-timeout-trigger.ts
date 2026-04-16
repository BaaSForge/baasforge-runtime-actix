import { queueWorker, sdk } from "@sdk";

export type Input = { item: string };
export type BatchOutput = { count: number; timedOut: true };

export default queueWorker<Input[], BatchOutput>({
  metadata: { batch: { size: 100, timeout: "1s" } },
  async process(_ctx, items) {
    void sdk;
    return { count: items.length, timedOut: true };
  },
});
