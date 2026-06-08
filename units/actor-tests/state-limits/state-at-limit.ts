import { actor } from "@sdk";

export type State = { data: string };
export type SetLargeStateInput = { data: string };
export type SetLargeStateOutput = { size: number };

export default actor<State>({
  state: { data: "" },
  handlers: {
    setLargeState(ctx, { data }: SetLargeStateInput): SetLargeStateOutput {
      ctx.state.data = data;
      return { size: data.length };
    },
  },
});
