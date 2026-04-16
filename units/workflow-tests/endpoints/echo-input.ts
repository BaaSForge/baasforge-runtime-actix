import { workflow, sdk } from "@sdk";

export type Input = unknown;
export type Output = unknown;

/**
 * Identity workflow — returns whatever input it receives.
 * Used by endpoint contract tests for start / result / cancel validation.
 */
export default workflow(async (_ctx, input) => {
  void sdk;
  return input;
});
