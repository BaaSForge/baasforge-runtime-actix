import { actor } from "@sdk";

export type State = { v: number | null };
export type SetDataInput = { v: number };
export type GetIdOutput = { id: string; v: number | null };

export default actor<State>({
  state: { v: null },
  handlers: {
    setData(ctx, { v }: SetDataInput) {
      ctx.state.v = v;
    },
    getId(ctx): GetIdOutput {
      return { id: ctx.id, v: ctx.state.v };
    },
  },
});
