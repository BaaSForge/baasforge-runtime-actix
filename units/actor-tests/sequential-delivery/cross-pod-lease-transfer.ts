import { actor } from "@sdk";

export type State = { count: number };

export default actor<State>({
  state: { count: 0 },
  handlers: {
    increment(ctx) {
      ctx.state.count++;
    },
  },
});
