import { workflow, sdk } from "@sdk";

export default workflow(async (ctx) => {
  void sdk;

  await ctx.run("set-initial", async () => {
    ctx.set("counter", 1);
    ctx.set("tag", "first");
    return true;
  });

  await ctx.sleep("first-suspend", { milliseconds: 50 });

  const mid = await ctx.run("read-and-update", async () => {
    const counter = await ctx.get<number>("counter");
    const tag = await ctx.get<string>("tag");
    ctx.set("counter", (counter ?? 0) + 1);
    ctx.set("tag", "second");
    return { counter, tag };
  });

  await ctx.sleep("second-suspend", { milliseconds: 50 });

  const final = await ctx.run("read-final", async () => ({
    counter: await ctx.get<number>("counter"),
    tag: await ctx.get<string>("tag"),
  }));

  return {
    mid,
    final,
    counterProgressed: mid.counter === 1 && final.counter === 2,
    tagProgressed: mid.tag === "first" && final.tag === "second",
  };
});
