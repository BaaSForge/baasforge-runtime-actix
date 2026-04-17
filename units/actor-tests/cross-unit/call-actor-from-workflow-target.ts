import { actor } from "@sdk";

type State = { value: number | null };

export default actor<State>({
  state: { value: null },
  handlers: {
    set(ctx, { value }: { value: number }) {
      ctx.state.value = value;
      return { ok: true };
    },
  },
});
