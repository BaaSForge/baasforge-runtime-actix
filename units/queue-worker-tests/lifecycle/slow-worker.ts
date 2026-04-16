import { queueWorker, sdk } from "@sdk";

export type Input = { sleepMs?: number };
export type Output = { done: true };

export default queueWorker<Input, Output>(async (_ctx, data) => {
  void sdk;
  await new Promise((resolve) => setTimeout(resolve, data.sleepMs ?? 3000));
  return { done: true };
});
