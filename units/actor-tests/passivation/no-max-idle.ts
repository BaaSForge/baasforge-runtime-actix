import { actor } from "@sdk";

export type State = { n: number };

export default actor<State>({
  state: { n: 0 },
  handlers: {
    bump(ctx) {
      ctx.state.n++;
    },
  },
});
