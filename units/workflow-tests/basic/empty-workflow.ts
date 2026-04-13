import { workflow, sdk } from "@sdk";

type Input = { value: unknown };

/**
 * No ctx.run — output is exactly the trigger payload (identity workflow).
 */
export default workflow<Input, Input>(async (_ctx, input) => {
  void sdk;
  return input;
});
