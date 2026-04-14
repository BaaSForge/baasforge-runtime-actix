import { workflow, sdk } from "@sdk";

export type Input = Record<string, never>;

export type Output = {
  /** Should stay 1 if TerminalError prevented step retries */
  terminalInvocations: number;
};

// NOTE(ctx-set-in-failing-step): The invocation counter is incremented via ctx.set
// inside a step closure that always throws TerminalError. This test is valid only if
// ctx.set writes persist even when the enclosing step closure throws. If writes are
// rolled back on failure the counter reads 0 after the catch, making the check
// `terminalInvocations: 1` fail — masking rather than catching a retry bug.
// Additionally, if TerminalError does NOT suppress retries, each retry increments
// the counter, so a value > 1 would correctly indicate the bug.
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
