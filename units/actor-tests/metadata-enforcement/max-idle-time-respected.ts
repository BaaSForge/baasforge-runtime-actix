import { actor } from "@sdk";

type State = { count: number };

export default actor<State>({
  metadata: { maxIdleTime: "5s" },
  state: { count: 0 },
  handlers: {
    increment(ctx) {
      ctx.state.count++;
    },
  },
});
