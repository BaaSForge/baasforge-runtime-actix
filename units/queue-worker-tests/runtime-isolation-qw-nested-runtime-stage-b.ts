import { queueWorker } from "@sdk";

export type Input = { marker: string };
export type Output = { runtimeScope: "stage-b"; marker: string };

export default queueWorker<Input, Output>(async (_ctx, data) => {
  return { runtimeScope: "stage-b", marker: data.marker };
});
