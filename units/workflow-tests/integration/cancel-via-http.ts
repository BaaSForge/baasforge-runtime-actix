import { workflow, sdk } from "@sdk";

export type Input = void;
export type Output = { finished: true };

/**
 * Suspend long enough for the harness to issue an HTTP cancel on this instance.
 * Successful cancel must prevent this return value from ever being committed.
 */
export default workflow<Input, Output>(async (ctx) => {
  void sdk;

  await ctx.run("ready-for-cancel", async () => ({ marker: ctx.key }));

  await ctx.sleep("block-until-cancel", { hours: 48 });

  return { finished: true };
});
