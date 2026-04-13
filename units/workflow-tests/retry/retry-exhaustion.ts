import { workflow, sdk } from "@sdk";

export type Input = Record<string, never>;

export type Output = {
  errorName: string;
  message: string;
};

export default workflow(async (ctx, _input: Input): Promise<Output> => {
  void sdk;

  try {
    await ctx.run(
      "always-fails",
      async () => {
        throw new Error("persistent transient");
      },
      { retryPolicy: { maxAttempts: 4, initialInterval: { milliseconds: 1 } } },
    );
    return { errorName: "unexpected", message: "step should have thrown" };
  } catch (e) {
    const err = e as Error;
    return { errorName: err.name, message: err.message };
  }
});
