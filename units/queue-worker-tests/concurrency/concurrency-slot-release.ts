import { queueWorker, sdk } from "@sdk";

export type Input = { id: number };
export type Output = { id: number; completedAt: number };

export default queueWorker<Input, Output>({
  metadata: { concurrency: 1 },
  async process(_ctx, data) {
    void sdk;
    await new Promise((resolve) => setTimeout(resolve, 200));
    return { id: data.id, completedAt: Date.now() };
  },
});
