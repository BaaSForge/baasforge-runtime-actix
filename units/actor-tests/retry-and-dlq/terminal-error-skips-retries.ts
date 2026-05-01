/**
 * @active ACTOR LLM PROMPT EXAMPLE
 *
 * @covers `metadata.retry`, `ctx.attempt`, persisting attempt info on `ctx.state`, and
 * `throw new ctx.TerminalError(...)` to skip further retries.
 *
 * @important Do not remove unless equivalent coverage is provided elsewhere in the prompt.
 */
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
