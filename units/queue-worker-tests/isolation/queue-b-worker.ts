import { queueWorker, sdk } from "@sdk";

export type Input = { value: string };
export type Output = { queue: "b"; value: string };

export default queueWorker<Input, Output>(async (_ctx, data) => {
  void sdk;
  return { queue: "b", value: data.value };
});
