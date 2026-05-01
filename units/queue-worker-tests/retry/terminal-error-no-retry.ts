/**
 * @active QUEUE WORKER LLM PROMPT EXAMPLE
 *
 * @covers `new ctx.TerminalError(...)` to skip retries and reach `onDeadLetter` when dead-letter
 * is enabled.
 *
 * @important Do not remove unless equivalent coverage is provided elsewhere in the prompt.
 */
import { queueWorker, sdk } from "@sdk";

export type Input = Record<string, never>;
export type Output = never;

export default queueWorker<Input, never>({
  metadata: { retry: { maxAttempts: 10 }, deadLetter: { enabled: true } },
  async process(ctx, _data) {
    void sdk;
    throw new ctx.TerminalError("non-retriable: skip retries immediately");
  },
  async onDeadLetter(_ctx, _data, _error) {},
});
