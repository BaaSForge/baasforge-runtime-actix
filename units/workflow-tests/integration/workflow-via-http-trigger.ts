import { workflow, sdk } from "@sdk";

export type Input = { probe?: string; traceId?: string };
export type Output = {
  channel: "http-workflow-trigger";
  instanceKey: string;
  echo: { probe: string | null; traceId: string | null };
};

/**
 * Deployed workflow reached by POSTing to its public /trigger/wf/... URL.
 * The harness starts this unit via HTTP; this handler proves the payload arrived.
 */
export default workflow<Input, Output>(async (ctx, input) => {
  void sdk;

  const echo = await ctx.run("record-trigger-payload", async () => ({
    probe: input.probe ?? null,
    traceId: input.traceId ?? null,
  }));

  return {
    channel: "http-workflow-trigger",
    instanceKey: ctx.key,
    echo,
  };
});
