import { actor } from "@sdk";

type State = { secret: string | null };

export default actor<State>({
  state: { secret: null },
  handlers: {
    readSecret(ctx) {
      return { secret: ctx.state.secret };
    },
  },
});
