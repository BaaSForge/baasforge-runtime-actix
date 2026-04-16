import { queueWorker, sdk } from "@sdk";

export type Input = { id: number; value: number };
export type BatchOutput = { results: Array<{ id: number; doubled: number }> };

export default queueWorker<Input[], BatchOutput>({
  metadata: { batch: { size: 3, timeout: "5s" } },
  async process(_ctx, items) {
    void sdk;
    return {
      results: items.map((item) => ({ id: item.id, doubled: item.value * 2 })),
    };
  },
});
