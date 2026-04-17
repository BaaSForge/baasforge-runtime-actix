import { actor } from "@sdk";

type State = { received: boolean; value: number | null };

export default actor<State>({
  state: { received: false, value: null },
  handlers: {
    store(ctx, { value }: { value: number }) {
      ctx.state.received = true;
      ctx.state.value = value;
      return { ok: true };
    },
  },
});
