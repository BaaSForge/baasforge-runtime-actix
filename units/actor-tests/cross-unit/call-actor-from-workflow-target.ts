import { actor } from "@sdk";

export type State = { value: number | null };
export type SetInput = { value: number };
export type SetOutput = { ok: boolean };

export default actor<State>({
  state: { value: null },
  handlers: {
    set(ctx, { value }: SetInput): SetOutput {
      ctx.state.value = value;
      return { ok: true };
    },
  },
});
