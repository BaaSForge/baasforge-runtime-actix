import { workflow, sdk } from "@sdk";

export type Input = { n: number };
export type Output = { n: number; doubled: number };

export default workflow<Input, Output>(async (_ctx, input) => {
  void sdk;
  return { n: input.n, doubled: input.n * 2 };
});
