import { actor } from "@sdk";

export type State = { count: number; tag: string };
export type ReplaceStateOutput = State;

export default actor<State>({
  state: { count: 0, tag: "" },
  handlers: {
    replaceState(ctx): ReplaceStateOutput {
      ctx.state = { count: 7, tag: "reassigned" };
      return ctx.state;
    },
  },
});
