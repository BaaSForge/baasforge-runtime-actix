import { actor } from "@sdk";

type State = { receivedValue: number | null };

export default actor<State>({
  state: { receivedValue: null },
  handlers: {
    receive(ctx, { value }: { value: number }) {
      ctx.state.receivedValue = value;
      return { ok: true };
    },
  },
});
