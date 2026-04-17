import { actor } from "@sdk";

type State = { activated: boolean };

export default actor<State>({
  state: { activated: false },
  handlers: {
    hello(ctx) {
      ctx.state.activated = true;
      return { id: ctx.id, activated: true };
    },
  },
});
