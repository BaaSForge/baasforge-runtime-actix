import { queueWorker } from "@sdk";

export type Input = { marker: string };
export type Output = { runtimeScope: "prod"; marker: string };

export default queueWorker<Input, Output>(async (_ctx, data) => {
  return { runtimeScope: "prod", marker: data.marker };
});
