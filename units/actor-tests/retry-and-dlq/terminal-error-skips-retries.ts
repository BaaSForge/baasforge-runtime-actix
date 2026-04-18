import { actor } from "@sdk";

export type State = { attempt: number };

export default actor<State>({
  state: { attempt: 0 },
  metadata: { retry: { maxAttempts: 5 } },
  handlers: {
    throwTerminal(ctx) {
      ctx.state.attempt = ctx.attempt;
      throw new ctx.TerminalError("stop immediately");
    },
  },
});
