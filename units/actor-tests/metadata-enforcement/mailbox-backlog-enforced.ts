import { actor } from "@sdk";

type State = { count: number };

export default actor<State>({
  metadata: { mailboxBacklog: 10 },
  state: { count: 0 },
  handlers: {
    increment(ctx) {
      ctx.state.count++;
    },
  },
});
