import { queueWorker, sdk } from "@sdk";

export type Input = Record<string, never>;
export type Output = { receivedEmpty: true; keys: number };

export default queueWorker<Input, Output>(async (_ctx, data) => {
  void sdk;
  return { receivedEmpty: true, keys: Object.keys(data).length };
});
