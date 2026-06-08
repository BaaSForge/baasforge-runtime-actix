import { actor } from "@sdk";

export type State = { data: string };
export type SetLargeStateInput = { bytes: number };
export type SetLargeStateOutput = { size: number };

export default actor<State>({
  state: { data: "" },
  handlers: {
    setLargeState(ctx, { bytes }: SetLargeStateInput): SetLargeStateOutput {
      ctx.state.data = "x".repeat(bytes);
      return { size: bytes };
    },
  },
});
