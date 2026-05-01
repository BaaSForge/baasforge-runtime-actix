/**
 * @active QUEUE WORKER LLM PROMPT EXAMPLE
 *
 * @covers `ctx.id` (run id), `ctx.attempt` (1-based), and `ctx.enqueuedAt` (enqueue ms) on the
 * handler context.
 *
 * @important Do not remove unless equivalent coverage is provided elsewhere in the prompt.
 */
import { queueWorker, sdk } from "@sdk";

export type Input = Record<string, never>;
export type Output = {
  id: string;
  attempt: number;
  enqueuedAt: number;
  idIsUuid: boolean;
  attemptIsOne: boolean;
  enqueuedAtIsMs: boolean;
};

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default queueWorker<Input, Output>(async (ctx, _data) => {
  void sdk;
  return {
    id: ctx.id,
    attempt: ctx.attempt,
    enqueuedAt: ctx.enqueuedAt,
    idIsUuid: UUID_RX.test(ctx.id),
    attemptIsOne: ctx.attempt === 1,
    enqueuedAtIsMs: ctx.enqueuedAt > 1_000_000_000_000,
  };
});
