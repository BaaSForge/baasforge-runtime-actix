import { workflow, sdk, type ActorInstanceId } from "@sdk";

const ACTOR_PATH = "test.actor-tests.actor.http-same-unit-path-runtime-isolation";

export type Input = { actorId: string; tag: string };
export type Output = { tag: string; runtimeScope: string; unitPath: string };

export default workflow<Input, Output>(async (ctx, input) => {
  await ctx.run("send", () =>
    sdk.callActorAndWaitForResultSync<{ tag: string }, { ok: true }>({
      unitPath: ACTOR_PATH,
      actorId: input.actorId as ActorInstanceId,
      handler: "writeTag",
      payload: { tag: input.tag },
    }),
  );
  const t = await ctx.run("readTag", () =>
    sdk.callActorAndWaitForResultSync<Record<string, never>, { tag: string }>({
      unitPath: ACTOR_PATH,
      actorId: input.actorId as ActorInstanceId,
      handler: "readTag",
      payload: {},
    }),
  );
  const p = await ctx.run("probe", () =>
    sdk.callActorAndWaitForResultSync<Record<string, never>, { runtimeScope: string; unitPath: string }>({
      unitPath: ACTOR_PATH,
      actorId: input.actorId as ActorInstanceId,
      handler: "probe",
      payload: {},
    }),
  );
  return { tag: t.tag, runtimeScope: p.runtimeScope, unitPath: p.unitPath };
});
