import { actor } from "@sdk";

export type State = { attempt: number };
export type SucceedOnThirdOutput = State;

export default actor<State>({
  state: { attempt: 0 },
  metadata: { retry: { maxAttempts: 5 } },
  handlers: {
    succeedOnThird(ctx): SucceedOnThirdOutput {
      ctx.state.attempt = ctx.attempt;
      if (ctx.attempt < 3) throw new Error("transient");
      return ctx.state;
    },
  },
});
