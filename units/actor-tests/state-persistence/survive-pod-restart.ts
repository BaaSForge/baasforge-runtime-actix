import { actor } from "@sdk";

type State = { value: number | null };

export default actor<State>({
  state: { value: null },
  handlers: {
    write(ctx, { value }: { value: number }) {
      ctx.state.value = value;
    },
    read(ctx) {
      return { value: ctx.state.value };
    },
  },
});
