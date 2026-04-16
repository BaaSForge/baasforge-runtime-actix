import { queueWorker, sdk } from "@sdk";

export type Input = { x: number };
export type Output = { doubled: number; form: "simple" };

export default queueWorker<Input, Output>(async (_ctx, data) => {
  void sdk;
  return { doubled: data.x * 2, form: "simple" };
});
