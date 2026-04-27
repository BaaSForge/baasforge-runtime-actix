import { queueWorker } from "@sdk";

export type Input = { value: number };
export type Output = { echoed: number };

export default queueWorker<Input, Output>(async (_ctx, data) => {
  return { echoed: data.value };
});
