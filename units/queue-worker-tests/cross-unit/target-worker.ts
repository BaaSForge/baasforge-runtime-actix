import { queueWorker, sdk } from "@sdk";

export type Input = { payload: any };
export type Output = { received: any; ok: true };

export default queueWorker<Input, Output>(async (_ctx, data) => {
  void sdk;
  return { received: data.payload, ok: true };
});
