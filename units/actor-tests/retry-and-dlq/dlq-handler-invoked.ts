/**
 * @active ACTOR LLM PROMPT EXAMPLE
 *
 * @covers a handler that throws a normal `Error` until retries are exhausted, then
 * `onDeadLetter(ctx, handler, payload?, error?)` runs and may mutate `ctx.state`.
 *
 * @important Do not remove unless equivalent coverage is provided elsewhere in the prompt.
 */
import { actor } from "@sdk";

export type State = { dlqPayloadReceived: boolean };
export type FailAndDlqInput = unknown;

export default actor<State>({
  state: { dlqPayloadReceived: false },
  metadata: { retry: { maxAttempts: 1 } },
  handlers: {
    failAndDlq(ctx, payload: FailAndDlqInput) {
      throw new Error("trigger dlq");
    },
  },
  onDeadLetter(ctx, name, payload?, error?) {
    ctx.state.dlqPayloadReceived = payload !== undefined && payload !== null;
  },
});
