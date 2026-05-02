import { actor } from "@sdk";

export type State = { bumpCount: number };
export type SucceedOnThirdOutput = State & { lastAttempt: number };

export default actor<State>({
  state: { bumpCount: 0 },
  metadata: { retry: { maxAttempts: 5 } },
  handlers: {
    succeedOnThird(ctx): SucceedOnThirdOutput {
      ctx.state.bumpCount += 1;
      if (ctx.attempt < 3) throw new Error("transient");
      return { ...ctx.state, lastAttempt: ctx.attempt };
    },
  },
});
