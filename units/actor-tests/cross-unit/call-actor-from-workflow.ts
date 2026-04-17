import { workflow, sdk } from "@sdk";

export default workflow(async (ctx, data) => {
  const { actorId, value } = data;
  const result = await ctx.run("call-actor", () =>
    sdk.callActor("test.actor-tests.actor.call-actor-from-workflow-target", actorId, "set", { value })
  );
  return { ok: result?.ok === true };
});
