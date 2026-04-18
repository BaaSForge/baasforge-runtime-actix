import { actor } from "@sdk";

export type State = { value: number | null };
export type WriteInput = { value: number };
export type ReadOutput = { value: number | null };

export default actor<State>({
  state: { value: null },
  handlers: {
    write(ctx, { value }: WriteInput) {
      ctx.state.value = value;
    },
    read(ctx): ReadOutput {
      return { value: ctx.state.value };
    },
  },
});
