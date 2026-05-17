import { actor } from "@sdk";

export const ACTOR_VALUE_CANARY = 99;

export type State = { count: number };
export type CountOutput = { count: number };

export default actor<State>({
  state: { count: 0 },
  handlers: {
    get(ctx): CountOutput {
      return { count: ctx.state.count };
    },
  },
});
