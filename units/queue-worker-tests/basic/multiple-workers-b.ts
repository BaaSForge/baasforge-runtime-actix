import { queueWorker, sdk } from "@sdk";

export type Input = { tag: string };
export type Output = { worker: "b"; tag: string };

export default queueWorker<Input, Output>(async (_ctx, data) => {
  void sdk;
  return { worker: "b", tag: data.tag };
});
