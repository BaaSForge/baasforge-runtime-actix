import { actor } from "@sdk";

export type State = { value: number };
export type SetBaseInput = { value: number };

export default actor<State>({
  state: { value: 0 },
  handlers: {
    setBase(ctx, { value }: SetBaseInput) {
      ctx.state.value = value;
    },
    mutateAndThrow(ctx) {
      ctx.state.value = 9999;
      throw new Error("intentional failure");
    },
  },
});
