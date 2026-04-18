import { actor } from "@sdk";

export type State = { obj: unknown };
export type SetNestedInput = { obj: unknown };
export type SetNestedOutput = { ok: boolean };

export default actor<State>({
  state: { obj: null },
  handlers: {
    setNested(ctx, { obj }: SetNestedInput): SetNestedOutput {
      ctx.state.obj = obj;
      return { ok: true };
    },
  },
});
