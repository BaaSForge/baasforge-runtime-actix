import { actor } from "@sdk";

export type State = { v: number };
export type SetValueInput = { v: number };

export default actor<State>({
  state: { v: 0 },
  handlers: {
    setValue(ctx, { v }: SetValueInput) {
      ctx.state.v = v;
    },
  },
});
