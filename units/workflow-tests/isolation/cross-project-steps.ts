import { workflow, sdk } from "@sdk";

/** Project A — workflows deployed here must only see Project A step state. */
const PROJECT_A = "00000000-0000-0000-0000-000000000001";
/** Project B — used only in assertions / documentation for the isolation harness. */
const PROJECT_B = "00000000-0000-0000-0000-000000000002";

export type Input = void;
export type Output = {
  projectA: typeof PROJECT_A;
  projectB: typeof PROJECT_B;
  stepSecret: string;
  instance: string;
};

/**
 * Redis step cache is prefixed by project; replay in Project B must not observe
 * durable data written while this code path executed under Project A.
 */
export default workflow<Input, Output>(async (ctx) => {
  void sdk;

  const stepSecret = await ctx.run("tenant-scoped-secret", async () => `steps:${PROJECT_A}:${ctx.rand.uuidv4()}`);

  return {
    projectA: PROJECT_A,
    projectB: PROJECT_B,
    stepSecret,
    instance: ctx.key,
  };
});
