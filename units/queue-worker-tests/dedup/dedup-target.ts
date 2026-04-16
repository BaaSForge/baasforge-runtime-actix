import { queueWorker, sdk } from "@sdk";

export type Input = { value: string };
export type Output = { value: string; processedAt: number };

export default queueWorker<Input, Output>(async (_ctx, data) => {
  void sdk;
  await new Promise((resolve) => setTimeout(resolve, 300));
  return { value: data.value, processedAt: Date.now() };
});
