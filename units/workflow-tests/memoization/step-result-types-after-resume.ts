import { workflow, sdk } from "@sdk";

export default workflow(async (ctx) => {
  void sdk;

  const complex = await ctx.run("complex-types", async () => ({
    str: "hello-world",
    num: -3.14,
    bool: true,
    nil: null,
    arr: [1, "two", null, true],
    nested: { deep: { value: 42, tags: ["a", "b"] } },
    large: "x".repeat(1000),
  }));

  await ctx.sleep("suspend-boundary", { milliseconds: 50 });

  const verified = await ctx.run("verify-types", async () => ({
    strOk: complex.str === "hello-world",
    numOk: complex.num === -3.14,
    boolOk: complex.bool === true,
    nilOk: complex.nil === null,
    arrOk: Array.isArray(complex.arr) && complex.arr.length === 4,
    nestedOk: complex.nested?.deep?.value === 42,
    largeOk: complex.large?.length === 1000,
  }));

  return {
    complex,
    verified,
    allOk:
      verified.strOk &&
      verified.numOk &&
      verified.boolOk &&
      verified.nilOk &&
      verified.arrOk &&
      verified.nestedOk &&
      verified.largeOk,
  };
});
