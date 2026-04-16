import { workflow, sdk } from "@sdk";

export type Input = { value: unknown };
export type Output = { value: unknown };

/**
 * No ctx.run — output is exactly the trigger payload (identity workflow).
 */
export default workflow<Input, Input>(async (_ctx, input) => {
  void sdk;
  return input;
});
