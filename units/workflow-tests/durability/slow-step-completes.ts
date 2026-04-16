import { workflow, sdk } from "@sdk";

export default workflow(async (ctx) => {
  void sdk;

  const result = await ctx.run("compute-heavy", async () => {
    let sum = 0;
    for (let i = 0; i < 500_000; i++) sum += i;
    return { sum, done: true };
  });

  return { computed: result.sum, done: result.done };
});
