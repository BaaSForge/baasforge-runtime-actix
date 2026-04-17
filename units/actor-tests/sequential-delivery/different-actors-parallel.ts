import { actor } from "@sdk";

type State = { count: number };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export default actor<State>({
  state: { count: 0 },
  handlers: {
    async slowIncrement(ctx) {
      await sleep(500);
      ctx.state.count++;
      return ctx.state;
    },
  },
});
