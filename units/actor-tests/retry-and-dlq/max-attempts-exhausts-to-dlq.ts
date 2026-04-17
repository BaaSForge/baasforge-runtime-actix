import { actor } from "@sdk";

type State = { dlqInvoked: boolean; attempts: number };

export default actor<State>({
  state: { dlqInvoked: false, attempts: 0 },
  metadata: { retry: { maxAttempts: 3 } },
  handlers: {
    alwaysFail(ctx) {
      ctx.state.attempts = ctx.attempt;
      throw new Error("always fail");
    },
  },
  onDeadLetter(ctx, name, error?) {
    ctx.state.dlqInvoked = true;
  },
});
