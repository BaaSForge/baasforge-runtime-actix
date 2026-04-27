import { workflow } from "@sdk";

export type Input = { n: number };
export type Output = { doubled: number };

export default workflow<Input, Output>(async (_ctx, input) => {
  return { doubled: (input?.n ?? 0) * 2 };
});
