import { actor } from "@sdk";

export type State = { v: number };

export default actor<State>({
  metadata: { maxIdleTime: "5s" },
  state: { v: 0 },
  handlers: {
    write(ctx, x: { v: number }) {
      ctx.state.v = x.v;
    },
    peek(ctx): number {
      return ctx.state.v;
    },
  },
});
