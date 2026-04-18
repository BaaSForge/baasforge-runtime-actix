import { actor } from "@sdk";

export type State = { v: number };
export type SetInput = { v: number };

export default actor<State>({
  state: { v: 0 },
  handlers: {
    set(ctx, { v }: SetInput) {
      ctx.state.v = v;
    },
  },
});
