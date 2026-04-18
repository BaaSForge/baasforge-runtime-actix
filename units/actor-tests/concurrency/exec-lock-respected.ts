import { actor } from "@sdk";

export type State = { count: number };
export type SerializedIncrementInput = { seq: number };
export type SerializedIncrementOutput = { count: number; seq: number };

export default actor<State>({
  state: { count: 0 },
  handlers: {
    serializedIncrement(ctx, { seq }: SerializedIncrementInput): SerializedIncrementOutput {
      ctx.state.count++;
      return { count: ctx.state.count, seq };
    },
  },
});
