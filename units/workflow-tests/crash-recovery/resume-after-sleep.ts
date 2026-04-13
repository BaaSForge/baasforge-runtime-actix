import { workflow, sdk } from "@sdk";

export type Input = void;
export type Output = {
  beforeSleep: { token: string };
  afterSleep: { sawToken: string; resumed: boolean };
};

/**
 * Crash or kill the runtime while the workflow is suspended in ctx.sleep.
 * On wake, the post-sleep step must run once with the memoized pre-sleep data.
 */
export default workflow<Input, Output>(async (ctx) => {
  void sdk;

  const beforeSleep = await ctx.run("pre-sleep", async () => ({
    token: ctx.rand.uuidv4(),
  }));

  await ctx.sleep("crash-during-sleep-window", { milliseconds: 400 });

  const afterSleep = await ctx.run("post-sleep", async () => ({
    sawToken: beforeSleep.token,
    resumed: true,
  }));

  return { beforeSleep, afterSleep };
});
