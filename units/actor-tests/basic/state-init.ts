import { actor } from "@sdk";

export type State = { count: number; label: string };
export type GetStateOutput = State;

export default actor<State>({
  state: { count: 0, label: "" },
  handlers: {
    getState(ctx): GetStateOutput {
      return ctx.state;
    },
  },
});
