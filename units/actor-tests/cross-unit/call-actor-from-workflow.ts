import { workflow, sdk } from "@sdk";

// import type { SetInput, SetOutput } from "@units/test.actor-tests.actor.call-actor-from-workflow-target";
type SetInput = { value: number };
type SetOutput = { ok: boolean };

export default workflow(async (ctx, data) => {
  const { actorId, value } = data;
  const result = await ctx.run("call-actor", () =>
    sdk.callActor<SetInput, SetOutput>("test.actor-tests.actor.call-actor-from-workflow-target", actorId, "set", { value })
  );
  return { ok: result?.ok === true };
});
