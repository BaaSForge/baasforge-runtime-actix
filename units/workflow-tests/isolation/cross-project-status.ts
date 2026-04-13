import { workflow, sdk } from "@sdk";

const PROJECT_A = "00000000-0000-0000-0000-000000000001";
const PROJECT_B = "00000000-0000-0000-0000-000000000002";

export type Input = void;
export type Output = {
  projectA: typeof PROJECT_A;
  projectB: typeof PROJECT_B;
  instanceKey: string;
  /** Harness should query status while the sleep below is in flight from another client. */
  statusProbe: "during-sleep";
};

/**
 * Status APIs must authorize on project_id + instance; cross-tenant lookups fail closed.
 */
export default workflow<Input, Output>(async (ctx) => {
  void sdk;

  await ctx.run("publish-running", async () => ({ phase: "running" as const }));

  await ctx.sleep("status-query-window", { milliseconds: 300 });

  return {
    projectA: PROJECT_A,
    projectB: PROJECT_B,
    instanceKey: ctx.key,
    statusProbe: "during-sleep",
  };
});
