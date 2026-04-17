import { actor } from "@sdk";

type State = { a: number; b: number };

export default actor<State>({
  state: { a: 0, b: 0 },
  handlers: {
    setFields(ctx, { a, b }: { a: number; b: number }) {
      ctx.state.a = a;
      ctx.state.b = b;
      return { a: ctx.state.a, b: ctx.state.b };
    },
  },
});
