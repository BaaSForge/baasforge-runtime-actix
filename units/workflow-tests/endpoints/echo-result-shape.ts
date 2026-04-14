import { workflow, sdk } from "@sdk";

/** Identity workflow for verifying result endpoint response shape. */
export default workflow(async (_ctx, input) => {
  void sdk;
  return input;
});
