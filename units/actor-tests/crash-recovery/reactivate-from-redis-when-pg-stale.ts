import { actor } from "@sdk";

export type State = { value: number };
export type WriteInput = { value: number };
export type ReadOutput = State;

export default actor<State>({
  state: { value: 0 },
  handlers: {
    write(ctx, { value }: WriteInput) {
      ctx.state.value = value;
    },
    read(ctx): ReadOutput {
      return ctx.state;
    },
  },
});
