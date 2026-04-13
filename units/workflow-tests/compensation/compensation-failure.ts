import { workflow, sdk } from "@sdk";

export type Input = Record<string, never>;

export type Output = {
  /** Populated when a compensation durable step throws */
  compensationError: string | null;
  /** The first undo in reverse order (`undo-reserve`) completed before `undo-charge` ran */
  undoReserveCompleted: boolean;
};

export default workflow(async (ctx, _input: Input): Promise<Output> => {
  void sdk;

  const compensations: Array<() => Promise<void>> = [];
  let undoReserveCompleted = false;

  try {
    compensations.push(() =>
      ctx.run("undo-charge", async () => {
        throw new Error("compensation blew up");
      }),
    );
    await ctx.run("charge", async () => {
      ctx.set("charged", true);
    });

    compensations.push(() =>
      ctx.run("undo-reserve", async () => {
        undoReserveCompleted = true;
      }),
    );
    await ctx.run("reserve", async () => {
      ctx.set("reserved", true);
    });

    throw new ctx.TerminalError("abort");
  } catch (e) {
    if (e instanceof ctx.TerminalError) {
      try {
        for (const comp of [...compensations].reverse()) {
          await comp();
        }
        return { compensationError: null, undoReserveCompleted };
      } catch (compErr) {
        const err = compErr as Error;
        return { compensationError: err.message, undoReserveCompleted };
      }
    }
    throw e;
  }
});
