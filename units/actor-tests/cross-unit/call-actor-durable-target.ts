import { actor } from "@sdk";

export type State = { value: number | null; callCount: number };
export type SetInput = { value: number };
export type SetOutput = { ok: boolean; value: number };

export default actor<State>({
  state: { value: null, callCount: 0 },
  handlers: {
    set(ctx, { value }: SetInput): SetOutput {
      ctx.state.value = value;
      ctx.state.callCount += 1;
      return { ok: true, value };
    },
  },
});
