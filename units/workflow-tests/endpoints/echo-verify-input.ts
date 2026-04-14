import { workflow, sdk } from "@sdk";

/** Identity workflow for verifying input passthrough. */
export default workflow(async (_ctx, input) => {
  void sdk;
  return input;
});
