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
 *
 * TODO(false-positive): This test does not verify cross-project isolation at all.
 * PROJECT_B is never used at runtime — it appears only in the Output type and as a
 * comment placeholder. The workflow runs a single step under Project A, returns two
 * hardcoded UUID constants and a generated stepSecret. The harness checks:
 *   - `projectA` equals the hardcoded literal (trivially true)
 *   - `stepSecret` is not null (always true)
 *   - `instance` is not null (always true)
 * No step is ever executed under Project B, no cross-project cache lookup is
 * attempted, and no isolation boundary is exercised.
 *
 * Fix requires:
 *   1. Trigger the same workflow slug under Project B using the same instanceId.
 *   2. Assert that Project B's step result does NOT match the stepSecret written
 *      under Project A (cache miss — namespacing is enforced).
 *   3. Alternatively, expose a debug endpoint that performs a raw step-cache lookup
 *      under a different project ID and asserts a miss.
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
