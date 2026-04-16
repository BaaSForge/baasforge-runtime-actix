import { queueWorker, sdk } from "@sdk";

export type Input = { enqueuedBeforeRestart: boolean };
export type Output = { processed: true; enqueuedBeforeRestart: boolean };

export default queueWorker<Input, Output>(async (_ctx, data) => {
  void sdk;
  return { processed: true, enqueuedBeforeRestart: data.enqueuedBeforeRestart };
});
