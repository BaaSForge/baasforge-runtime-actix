import { actor } from "@sdk";

type State = { attempts: number };

export default actor<State>({
  metadata: { retry: { maxAttempts: 5 } },
  state: { attempts: 0 },
  handlers: {
    failFiveTimes(ctx) {
      ctx.state.attempts = ctx.attempt;
      throw new Error("always fail");
    },
  },
});
