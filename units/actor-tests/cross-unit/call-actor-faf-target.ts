import { actor } from "@sdk";

type State = { applied: boolean };

export default actor<State>({
  state: { applied: false },
  handlers: {
    fireAndForget(ctx) {
      ctx.state.applied = true;
      return { applied: true };
    },
  },
});
