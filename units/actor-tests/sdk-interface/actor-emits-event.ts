/**
 * @skipped ACTOR LLM PROMPT EXAMPLE
 *
 * @covers a minimal handler-only actor used once event triggers exist; the integration test is
 * skipped until that API ships.
 *
 * @important Do not remove unless equivalent coverage is provided elsewhere in the prompt.
 */
import { actor } from "@sdk";

export type State = { emitted: boolean };

export default actor<State>({
  state: { emitted: false },
  handlers: {
    emit(ctx) {
      ctx.state.emitted = true;
    },
  },
});
