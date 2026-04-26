import { workflow, sdk } from "@sdk";

const ACTOR = "test.actor-tests.actor.http-same-unit-path-runtime-isolation";
const WF = "test.wf.workflow.http-same-unit-path-runtime-isolation";
const QW = "test.queue-worker.queue_worker.http-same-unit-path-runtime-isolation";

export type Input = { actorId: string; marker: string };
export type Output = {
  actorScope: string;
  actorUnitPath: string;
  wfScope: string;
  wfUnitPath: string;
  wfMarker: string | null;
  qwRunId: string;
};

export default workflow<Input, Output>(async (ctx, input) => {
  const ar = await ctx.run("actor", () =>
    sdk.callActorAndWaitForResultSync<Record<string, never>, { runtimeScope: string; unitPath: string }>(
      ACTOR,
      input.actorId,
      "probe",
      {},
    ),
  );
  const wf = sdk.callWorkflowAndWaitForOutputSync<
    { marker?: string },
    { runtimeScope: string; unitPath: string; marker: string | null }
  >(WF, { marker: input.marker });
  const enq = await ctx.run("qw", () => sdk.enqueueWorkerSync<{ marker: string }>(QW, { marker: input.marker }));
  return {
    actorScope: ar.runtimeScope,
    actorUnitPath: ar.unitPath,
    wfScope: wf.runtimeScope,
    wfUnitPath: wf.unitPath,
    wfMarker: wf.marker,
    qwRunId: enq.runId,
  };
});
