import { actor } from "@sdk";

export type State = { received: boolean; value: number | null };
export type StoreInput = { value: number };
export type StoreOutput = { ok: boolean };

export default actor<State>({
  state: { received: false, value: null },
  handlers: {
    store(ctx, { value }: StoreInput): StoreOutput {
      ctx.state.received = true;
      ctx.state.value = value;
      return { ok: true };
    },
  },
});
