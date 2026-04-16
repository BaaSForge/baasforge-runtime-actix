import { workflow, sdk } from "@sdk";

export type Input = { tag: string };
export type Output = { tag: string; readBack: string | null; isolatedCorrectly: boolean };

export default workflow<Input, Output>(async (ctx, input) => {
  void sdk;

  const tag = input?.tag ?? "unknown";

  await ctx.run("set-tag", async () => {
    ctx.set("instance-tag", tag);
    return true;
  });

  const readBack = await ctx.run("get-tag", async () => ctx.get<string>("instance-tag"));

  return { tag, readBack, isolatedCorrectly: readBack === tag };
});
