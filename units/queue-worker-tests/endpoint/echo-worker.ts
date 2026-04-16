import { queueWorker, sdk } from "@sdk";

export type Input = any;
export type Output = { echo: any };

export default queueWorker<Input, Output>(async (_ctx, data) => {
  void sdk;
  return { echo: data };
});
