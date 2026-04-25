import { workflow } from "@sdk";

export type Input = { marker?: string };
export type Output = { runtimeScope: "stage-a"; marker: string | null };

export default workflow<Input, Output>(async (_ctx, input) => {
  return { runtimeScope: "stage-a", marker: input.marker ?? null };
});
