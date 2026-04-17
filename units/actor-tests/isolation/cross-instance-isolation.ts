import { actor } from "@sdk";

type State = { v: number | null };

export default actor<State>({
  state: { v: null },
  handlers: {
    setValue(ctx, { v }: { v: number }) {
      ctx.state.v = v;
    },
  },
});
