import { workflow, sdk } from "@sdk";

export type Input = Record<string, never>;

export type Output = {
  /** Only the undo for the completed forward step should appear */
  compensationOrder: string[];
};

export default workflow(async (ctx, _input: Input): Promise<Output> => {
  void sdk;

  const compensations: Array<() => Promise<void>> = [];
  const compensationOrder: string[] = [];

  compensations.push(() =>
    ctx.run("undo-reserve", async () => {
      compensationOrder.push("undo-reserve");
    }),
  );
  await ctx.run("reserve", async () => {
    ctx.set("reserved", true);
  });

  try {
    await ctx.run("charge", async () => {
      throw new ctx.TerminalError("charge-never-completed");
    });
  } catch (e) {
    if (e instanceof ctx.TerminalError) {
      for (const comp of [...compensations].reverse()) {
        await comp();
      }
      return { compensationOrder };
    }
    throw e;
  }

  return { compensationOrder: [] };
});
