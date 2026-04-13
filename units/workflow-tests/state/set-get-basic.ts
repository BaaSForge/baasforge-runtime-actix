import { workflow, sdk } from "@sdk";

/**
 * Verifies ctx.set() followed by ctx.get() returns the stored value for this instance.
 */
export default workflow(async (ctx, _input) => {
  return await ctx.run("round-trip", async () => {
    ctx.set("token", "hello");
    const value = await ctx.get<string>("token");
    return {
      ok: value === "hello",
      value,
    };
  });
});
