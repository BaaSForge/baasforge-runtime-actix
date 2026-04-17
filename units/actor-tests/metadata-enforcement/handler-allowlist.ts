import { actor } from "@sdk";

type State = { count: number };

export default actor<State>({
  metadata: { handlers: ["allowedHandler"] },
  state: { count: 0 },
  handlers: {
    allowedHandler(ctx) {
      ctx.state.count++;
      return { count: ctx.state.count };
    },
  },
});
