import { queueWorker, sdk } from "@sdk";

export type Input = { n: number };
export type Output = { doubled: number; asyncDone: true };

export default queueWorker<Input, Output>(async (_ctx, data) => {
  void sdk;
  const result = await new Promise<number>((resolve) =>
    setTimeout(() => resolve(data.n * 2), 50),
  );
  return { doubled: result, asyncDone: true };
});
