import { actor } from "@sdk";

type State = { v: string | null };

export default actor<State>({
  state: { v: null },
  handlers: {
    setValue(ctx, { v }: { v: string }) {
      ctx.state.v = v;
    },
    getValue(ctx) {
      return ctx.state;
    },
  },
});
