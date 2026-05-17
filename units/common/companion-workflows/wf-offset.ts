import { workflow } from "@sdk";
import { withOffset } from "@units/test.common.common.offset";

export type Input = { n: number };
export type Output = { result: number };

export default workflow<Input, Output>({
  run: async (ctx, input) => {
    return await ctx.run("offset-step", () => ({ result: withOffset(input.n) }));
  },
});
