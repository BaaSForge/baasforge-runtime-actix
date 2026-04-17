import { actor } from "@sdk";

type State = { obj: unknown };

export default actor<State>({
  state: { obj: null },
  handlers: {
    setNested(ctx, { obj }: { obj: unknown }) {
      ctx.state.obj = obj;
      return { ok: true };
    },
  },
});
