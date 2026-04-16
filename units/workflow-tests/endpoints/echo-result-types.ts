import { workflow, sdk } from "@sdk";

export type Input = unknown;
export type Output = unknown;

/** Identity workflow for verifying complex type preservation through result endpoint. */
export default workflow(async (_ctx, input) => {
  void sdk;
  return input;
});
