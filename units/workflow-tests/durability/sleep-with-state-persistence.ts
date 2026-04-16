import { workflow, sdk } from "@sdk";

export type Input = void;
export type Output = { beforeSleep: string; afterSleep: string | null; persisted: boolean };

export default workflow(async (ctx) => {
  void sdk;

  const beforeSleep = await ctx.run("set-before-sleep", async () => {
    ctx.set("persisted-value", "before-sleep");
    return "before-sleep";
  });

  await ctx.sleep("suspend-boundary", { milliseconds: 50 });

  const afterSleep = await ctx.run("get-after-sleep", async () => {
    return await ctx.get<string>("persisted-value");
  });

  return {
    beforeSleep,
    afterSleep,
    persisted: afterSleep === "before-sleep",
  };
});
