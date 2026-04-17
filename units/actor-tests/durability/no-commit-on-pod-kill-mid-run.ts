import { actor } from "@sdk";

type State = { value: number };

export default actor<State>({
  state: { value: 0 },
  handlers: {
    setBase(ctx, { value }: { value: number }) {
      ctx.state.value = value;
    },
  },
});
