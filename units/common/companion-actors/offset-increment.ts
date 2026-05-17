import { actor } from "@sdk";
import { withOffset } from "@units/test.common.common.offset";

export type State = { count: number };
export type IncrementInput = { by?: number };
export type CountOutput = { count: number };

export default actor<State>({
  state: { count: 0 },
  handlers: {
    increment(ctx, payload?: IncrementInput): CountOutput {
      const by = payload?.by ?? 1;
      ctx.state.count = withOffset(ctx.state.count + by);
      return { count: ctx.state.count };
    },
    get(ctx): CountOutput {
      return { count: ctx.state.count };
    },
  },
});
