import { actor } from "@sdk";

export type State = { c: number };

export default actor<State>({
  metadata: { maxIdleTime: "5s" },
  state: { c: 0 },
  handlers: {
    inc(ctx) {
      ctx.state.c++;
    },
  },
});
