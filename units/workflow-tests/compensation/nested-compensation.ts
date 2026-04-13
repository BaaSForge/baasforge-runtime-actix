import { workflow, sdk } from "@sdk";

export type Input = Record<string, never>;

export type Output = {
  outerUndoRan: boolean;
  innerLedger: string | null;
};

export default workflow(async (ctx, _input: Input): Promise<Output> => {
  void sdk;

  const compensations: Array<() => Promise<void>> = [];
  let outerUndoRan = false;

  try {
    compensations.push(() =>
      ctx.run("outer-undo", async () => {
        outerUndoRan = true;
        await ctx.run("inner-ledger-entry", async () => {
          ctx.set("ledger", "nested-compensation-step");
          return "recorded";
        });
      }),
    );
    await ctx.run("forward", async () => {
      ctx.set("forward", "ok");
    });

    throw new ctx.TerminalError("rollback");
  } catch (e) {
    if (e instanceof ctx.TerminalError) {
      for (const comp of [...compensations].reverse()) {
        await comp();
      }
      const innerLedger = await ctx.get<string>("ledger");
      return { outerUndoRan, innerLedger };
    }
    throw e;
  }
});
