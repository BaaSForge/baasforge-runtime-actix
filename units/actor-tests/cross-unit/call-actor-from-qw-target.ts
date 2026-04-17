import { actor } from "@sdk";

type State = { touched: boolean };

export default actor<State>({
  state: { touched: false },
  handlers: {
    touch(ctx) {
      ctx.state.touched = true;
      return { ok: true };
    },
  },
});
