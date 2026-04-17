import { actor } from "@sdk";

type State = { v: number };

export default actor<State>({
  state: { v: 0 },
  handlers: {
    setValue(ctx, { v }: { v: number }) {
      ctx.state.v = v;
    },
  },
});
