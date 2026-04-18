import { actor } from "@sdk";

export type State = { count: number };
export type SlowIncrementOutput = State;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export default actor<State>({
  state: { count: 0 },
  handlers: {
    async slowIncrement(ctx): Promise<SlowIncrementOutput> {
      await sleep(500);
      ctx.state.count++;
      return ctx.state;
    },
  },
});
