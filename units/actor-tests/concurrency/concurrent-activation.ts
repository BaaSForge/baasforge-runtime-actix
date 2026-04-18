import { actor } from "@sdk";

export type State = { count: number };
export type IncrementOutput = { count: number };

export default actor<State>({
  state: { count: 0 },
  handlers: {
    increment(ctx): IncrementOutput {
      ctx.state.count++;
      return { count: ctx.state.count };
    },
  },
});
