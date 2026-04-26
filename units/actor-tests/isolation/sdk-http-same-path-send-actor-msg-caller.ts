import { workflow, sdk } from "@sdk";

const ACTOR_PATH = "test.actor-tests.actor.http-same-unit-path-runtime-isolation";

export type Input = { actorId: string; tag: string };
export type Output = { tag: string; runtimeScope: string; unitPath: string };

export default workflow<Input, Output>(async (ctx, input) => {
  await ctx.run("send", () =>
    sdk.sendActorMessageSync<{ tag: string }>(ACTOR_PATH, input.actorId, "writeTag", { tag: input.tag }),
  );
  const t = await ctx.run("readTag", () =>
    sdk.callActorAndWaitForResultSync<Record<string, never>, { tag: string }>(
      ACTOR_PATH,
      input.actorId,
      "readTag",
      {},
    ),
  );
  const p = await ctx.run("probe", () =>
    sdk.callActorAndWaitForResultSync<Record<string, never>, { runtimeScope: string; unitPath: string }>(
      ACTOR_PATH,
      input.actorId,
      "probe",
      {},
    ),
  );
  return { tag: t.tag, runtimeScope: p.runtimeScope, unitPath: p.unitPath };
});
