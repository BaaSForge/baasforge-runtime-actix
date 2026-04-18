import { actor } from "@sdk";

export type State = { v: string | null };
export type SetValueInput = { v: string };
export type GetValueOutput = State;

export default actor<State>({
  state: { v: null },
  handlers: {
    setValue(ctx, { v }: SetValueInput) {
      ctx.state.v = v;
    },
    getValue(ctx): GetValueOutput {
      return ctx.state;
    },
  },
});
