import { queueWorker, sdk } from "@sdk";

export type Input = { value: number };
export type Output = { doubled: number };

export default queueWorker<Input, Output>(async (_ctx, data) => {
  void sdk;
  return { doubled: data.value * 2 };
});
