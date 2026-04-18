import { actor } from "@sdk";

export type State = { v: number | null };
export type SetValueInput = { v: number };

export default actor<State>({
  state: { v: null },
  handlers: {
    setValue(ctx, { v }: SetValueInput) {
      ctx.state.v = v;
    },
  },
});
