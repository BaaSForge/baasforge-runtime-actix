import { actor } from "@sdk";

export type State = { activated: boolean };
export type HelloOutput = { id: string; activated: boolean };

export default actor<State>({
  state: { activated: false },
  handlers: {
    hello(ctx): HelloOutput {
      ctx.state.activated = true;
      return { id: ctx.id, activated: true };
    },
  },
});
