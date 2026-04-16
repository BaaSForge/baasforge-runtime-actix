import { queueWorker, sdk } from "@sdk";

export type Input = { item: string };
export type BatchOutput = { count: number; items: string[] };

export default queueWorker<Input[], BatchOutput>({
  metadata: { batch: { size: 3, timeout: "10s" } },
  async process(_ctx, items) {
    void sdk;
    return { count: items.length, items: items.map((i) => i.item) };
  },
});
