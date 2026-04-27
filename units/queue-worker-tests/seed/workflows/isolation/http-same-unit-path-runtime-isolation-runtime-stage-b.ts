import { workflow } from "@sdk";

export const HTTP_SAME_UNIT_PATH = "test.wf.workflow.http-same-unit-path-runtime-isolation";

export type Input = { marker?: string };
export type Output = { runtimeScope: "stage-b"; unitPath: string; marker: string | null };

export default workflow<Input, Output>(async (_ctx, input) => {
  return {
    runtimeScope: "stage-b",
    unitPath: HTTP_SAME_UNIT_PATH,
    marker: input.marker ?? null,
  };
});
