import { queueWorker, sdk } from "@sdk";

export type Input = { id: string };
export type Output = { id: string; processedAt: number };

export default queueWorker<Input, Output>(async (_ctx, data) => {
  void sdk;
  return { id: data.id, processedAt: Date.now() };
});
