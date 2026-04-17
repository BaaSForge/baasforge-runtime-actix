import { actor } from "@sdk";

type State = { data: string };

export default actor<State>({
  state: { data: "" },
  handlers: {
    setLargeState(ctx, { data }: { data: string }) {
      ctx.state.data = data;
      return { size: data.length };
    },
  },
});
