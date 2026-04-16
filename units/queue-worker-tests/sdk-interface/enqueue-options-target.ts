import { queueWorker, sdk } from "@sdk";

export type Input = { label: string };
export type Output = { label: string; receivedAt: number };

export default queueWorker<Input, Output>(async (_ctx, data) => {
  void sdk;
  return { label: data.label, receivedAt: Date.now() };
});
