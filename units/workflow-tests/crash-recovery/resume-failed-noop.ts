import { workflow, sdk } from "@sdk";

export default workflow(async (ctx) => {
  void sdk;
  void ctx;
  throw new Error("intentional-failure-for-noop-test");
});
