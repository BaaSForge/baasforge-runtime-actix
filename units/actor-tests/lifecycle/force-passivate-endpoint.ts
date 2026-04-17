import { actor } from "@sdk";

type State = { count: number };

export default actor<State>({
  state: { count: 0 },
  handlers: {
    activate(ctx) {
      ctx.state.count++;
      return { id: ctx.id };
    },
  },
});
