import { actor } from "@sdk";

export type State = { count: number };
export type ReadStateOutput = State;

export default actor<State>({
  state: { count: 0 },
  handlers: {
    readState(ctx): ReadStateOutput {
      return ctx.state;
    },
  },
});
