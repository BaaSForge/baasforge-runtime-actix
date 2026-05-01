/**
 * @active WORKFLOW LLM PROMPT EXAMPLE
 *
 * @covers the compensation (saga-undo) pattern — registering undo
 * `ctx.run` closures as forward steps succeed, then executing them in reverse order inside
 * a `ctx.TerminalError` catch block
 *
 * @important Do not remove unless equivalent coverage is provided elsewhere in the prompt.
 */
import { workflow, sdk } from "@sdk";

export type Input = Record<string, never>;

export type Output = {
  /** Undo steps in actual execution order (reverse of successful forward registration) */
  compensationOrder: string[];
};

export default workflow(async (ctx, _input: Input): Promise<Output> => {
  void sdk;

  const compensations: Array<() => Promise<void>> = [];
  const compensationOrder: string[] = [];

  try {
    compensations.push(() =>
      ctx.run("undo-charge", async () => {
        compensationOrder.push("undo-charge");
      }),
    );
    await ctx.run("charge", async () => {
      ctx.set("charged", true);
    });

    compensations.push(() =>
      ctx.run("undo-reserve", async () => {
        compensationOrder.push("undo-reserve");
      }),
    );
    await ctx.run("reserve", async () => {
      ctx.set("reserved", true);
    });

    throw new ctx.TerminalError("abort-after-reserve");
  } catch (e) {
    if (e instanceof ctx.TerminalError) {
      for (const comp of [...compensations].reverse()) {
        await comp();
      }
      return { compensationOrder };
    }
    throw e;
  }
});
