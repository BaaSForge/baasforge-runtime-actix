import { workflow } from "@sdk";

export type Input = { marker?: string };
export type Output = { runtimeScope: "stage-b"; marker: string | null };

export default workflow<Input, Output>(async (_ctx, input) => {
  return { runtimeScope: "stage-b", marker: input.marker ?? null };
});
