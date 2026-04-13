import { workflow, sdk } from "@sdk";

export type Input = { label?: string };
export type Output = {
  status: "completed";
  label: string;
  digest: string;
  completedAt: number;
};

/**
 * Happy path: workflow runs to completion; the returned object is the persisted
 * final result the harness reads from storage / the /result attachment API.
 */
export default workflow<Input, Output>(async (ctx, input) => {
  void sdk;

  const label = input.label ?? "default";

  const digest = await ctx.run("compute-digest", async () => {
    const base = `${ctx.key}:${label}:${ctx.rand.uuidv4()}`;
    return `sha256:${base.length.toString(16)}:${base.slice(0, 8)}`;
  });

  return {
    status: "completed",
    label,
    digest,
    completedAt: ctx.date.now(),
  };
});
