import { workflow, sdk } from "@sdk";

type Output = {
  str: string;
  num: number;
  obj: { id: number; label: string };
  arr: number[];
  nul: null;
};

/**
 * Each durable step returns a different JSON-serializable shape so replay can
 * round-trip strings, numbers, objects, arrays, and null.
 */
export default workflow<unknown, Output>(async (ctx) => {
  void sdk;

  const str = await ctx.run("returns-string", async () => "baal-workflow");
  const num = await ctx.run("returns-number", async () => -3.5);
  const obj = await ctx.run("returns-object", async () => ({ id: 7, label: "ok" }));
  const arr = await ctx.run("returns-array", async () => [10, 20, 30]);
  const nul = await ctx.run("returns-null", async () => null);

  return { str, num, obj, arr, nul };
});
