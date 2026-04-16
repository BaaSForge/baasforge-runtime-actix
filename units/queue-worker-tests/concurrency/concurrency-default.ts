import { queueWorker, sdk } from "@sdk";

export type Input = { id: number };
export type Output = { id: number; startedAt: number };

export default queueWorker<Input, Output>(async (_ctx, data) => {
  void sdk;
  return { id: data.id, startedAt: Date.now() };
});
