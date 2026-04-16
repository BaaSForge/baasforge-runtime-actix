import { queueWorker, sdk } from "@sdk";

export type Input = { value: number; label: string };
export type Output = { received: Input; processed: true };

export default queueWorker<Input, Output>(async (_ctx, data) => {
  void sdk;
  return { received: data, processed: true };
});
