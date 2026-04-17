import { actor } from "@sdk";

type State = { count: number; lastTag: string };

export default actor<State>({
  state: { count: 0, lastTag: "" },
  handlers: {
    readAndWrite(ctx, { tag }: { tag: string }) {
      ctx.state.lastTag = tag;
      ctx.state.count++;
      return ctx.state;
    },
  },
});
