import { workflow } from "@sdk";

export type Input = { marker?: string };
export type Output = { runtimeScope: "prod"; marker: string | null };

export default workflow<Input, Output>(async (_ctx, input) => {
  return { runtimeScope: "prod", marker: input.marker ?? null };
});
