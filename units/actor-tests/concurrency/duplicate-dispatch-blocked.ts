import { actor } from "@sdk";

export type State = { value: number | null };
export type IdempotentApplyInput = { value: number };
export type IdempotentApplyOutput = State;

export default actor<State>({
  state: { value: null },
  handlers: {
    idempotentApply(ctx, { value }: IdempotentApplyInput): IdempotentApplyOutput {
      ctx.state.value = value;
      return ctx.state;
    },
  },
});
