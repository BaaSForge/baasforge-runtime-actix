import { workflow, sdk } from "@sdk";

export type Input = Record<string, never>;

export type Output = {
  /** Should stay 1 if TerminalError prevented step retries */
  terminalInvocations: number;
};

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
