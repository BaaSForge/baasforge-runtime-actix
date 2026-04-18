import { actor } from "@sdk";

export type State = { count: number };
export type ActivateOutput = { id: string };

export default actor<State>({
  state: { count: 0 },
  handlers: {
    activate(ctx): ActivateOutput {
      ctx.state.count++;
      return { id: ctx.id };
    },
  },
});
