import { actor } from "@sdk";

export type State = { count: number };
export type IncrementOutput = State;

export default actor<State>({
  state: { count: 0 },
  handlers: {
    increment(ctx): IncrementOutput {
      ctx.state.count++;
      return ctx.state;
    },
  },
});
