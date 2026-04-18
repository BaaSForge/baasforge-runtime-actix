import { actor } from "@sdk";

export type State = { receivedValue: number | null };
export type ReceiveInput = { value: number };
export type ReceiveOutput = { ok: boolean };

export default actor<State>({
  state: { receivedValue: null },
  handlers: {
    receive(ctx, { value }: ReceiveInput): ReceiveOutput {
      ctx.state.receivedValue = value;
      return { ok: true };
    },
  },
});
