import { actor } from "@sdk";

export type State = { touched: boolean };
export type TouchOutput = { ok: boolean };

export default actor<State>({
  state: { touched: false },
  handlers: {
    touch(ctx): TouchOutput {
      ctx.state.touched = true;
      return { ok: true };
    },
  },
});
