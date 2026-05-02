import { actor } from "@sdk";

export type State = { n: number };

export default actor<State>({
  metadata: { maxIdleTime: 8000 },
  state: { n: 0 },
  handlers: {
    bump(ctx) {
      ctx.state.n++;
    },
  },
});
