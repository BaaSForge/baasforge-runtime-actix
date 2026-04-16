import { queueWorker, sdk } from "@sdk";

export type Input = { id: number };
export type Output = { id: number; processed: true };

export default queueWorker<Input, Output>({
  metadata: { rateLimit: { max: 2, window: "5s" } },
  async process(_ctx, data) {
    void sdk;
    return { id: data.id, processed: true };
  },
});
