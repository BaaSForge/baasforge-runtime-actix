import { actor } from "@sdk";

type State = { value: number | null; callCount: number };

export default actor<State>({
  state: { value: null, callCount: 0 },
  handlers: {
    set(ctx, { value }: { value: number }) {
      ctx.state.value = value;
      ctx.state.callCount += 1;
      return { ok: true, value };
    },
  },
});
