import { workflow, sdk } from "@sdk";

export type Input = unknown;
export type Output = {
  str: string | null;
  num: number | null;
  obj: { a: number; nested: { b: number } } | null;
  arr: number[] | null;
  nil: null;
};

/**
 * Persists strings, numbers, objects, arrays, and null; returns round-tripped values from ctx.get.
 */
export default workflow(async (ctx, _input) => {
  return await ctx.run("verify-types", async () => {
    ctx.set("str", "text");
    ctx.set("num", 7);
    ctx.set("obj", { a: 1, nested: { b: 2 } });
    ctx.set("arr", [1, 2, 3]);
    ctx.set("nil", null);

    return {
      str: await ctx.get<string>("str"),
      num: await ctx.get<number>("num"),
      obj: await ctx.get<{ a: number; nested: { b: number } }>("obj"),
      arr: await ctx.get<number[]>("arr"),
      nil: await ctx.get<null>("nil"),
    };
  });
});
