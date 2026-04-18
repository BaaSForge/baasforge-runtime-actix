import { actor } from "@sdk";

export type State = { v: number | null };
export type SetDataInput = { v: number };
export type GetDataOutput = State;

export default actor<State>({
  state: { v: null },
  handlers: {
    setData(ctx, { v }: SetDataInput) {
      ctx.state.v = v;
    },
    getData(ctx): GetDataOutput {
      return ctx.state;
    },
  },
});
