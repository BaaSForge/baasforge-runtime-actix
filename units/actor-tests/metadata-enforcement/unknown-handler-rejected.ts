import { actor } from "@sdk";

type State = { count: number };

export default actor<State>({
  metadata: { handlers: ["knownHandler"] },
  state: { count: 0 },
  handlers: {
    knownHandler(ctx) {
      ctx.state.count++;
      return { count: ctx.state.count };
    },
  },
});
