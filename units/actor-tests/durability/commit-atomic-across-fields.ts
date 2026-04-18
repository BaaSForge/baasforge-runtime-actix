import { actor } from "@sdk";

export type State = { a: number; b: number };
export type SetFieldsInput = { a: number; b: number };
export type SetFieldsOutput = { a: number; b: number };

export default actor<State>({
  state: { a: 0, b: 0 },
  handlers: {
    setFields(ctx, { a, b }: SetFieldsInput): SetFieldsOutput {
      ctx.state.a = a;
      ctx.state.b = b;
      return { a: ctx.state.a, b: ctx.state.b };
    },
  },
});
