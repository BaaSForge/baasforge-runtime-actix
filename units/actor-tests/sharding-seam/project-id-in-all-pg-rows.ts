import { actor } from "@sdk";

type State = { v: number };

export default actor<State>({
  state: { v: 0 },
  handlers: {
    set(ctx, { v }: { v: number }) {
      ctx.state.v = v;
    },
  },
});
