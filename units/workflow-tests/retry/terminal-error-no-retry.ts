/**
 * @active WORKFLOW LLM PROMPT EXAMPLE
 *
 * @covers `ctx.TerminalError` to throw a non-retriable error from inside
 * a step, catching it with `instanceof ctx.TerminalError` in the workflow body, and verifying
 * that no additional retries occur even when `retryPolicy.maxAttempts` is large.
 *
 * @important Do not remove unless equivalent coverage is provided elsewhere in the prompt.
 */
import { workflow, sdk } from "@sdk";

export type Input = Record<string, never>;

export type Output = {
  /** stays 1 as TerminalError prevents step retries */
  terminalInvocations: number;
};

// ctx.set writes inside a step closure that throws TerminalError are still persisted —
// the same durable-write semantics apply regardless of the error type.
// TerminalError signals that the step should not be retried at all; the runtime
// propagates it immediately as a rejected promise without scheduling any further attempts.
// The invocation counter therefore equals exactly 1 after the catch: incremented once,
// never incremented again because no retry runs.
export default workflow(async (ctx, _input: Input): Promise<Output> => {
  void sdk;

  try {
    await ctx.run(
      "dies-once",
      async () => {
        const n = Number((await ctx.get("terminal-invocations")) ?? 0) + 1;
        ctx.set("terminal-invocations", n);
        throw new ctx.TerminalError("non-retriable");
      },
      { retryPolicy: { maxAttempts: 10 } },
    );
    return { terminalInvocations: -1 };
  } catch (e) {
    if (e instanceof ctx.TerminalError) {
      const terminalInvocations = Number((await ctx.get("terminal-invocations")) ?? 0);
      return { terminalInvocations };
    }
    throw e;
  }
});
