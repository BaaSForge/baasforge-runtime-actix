import { actor } from "@sdk";

type State = { count: number; label: string };

export default actor<State>({
  state: { count: 0, label: "" },
  handlers: {
    getState(ctx) {
      return ctx.state;
    },
  },
});
