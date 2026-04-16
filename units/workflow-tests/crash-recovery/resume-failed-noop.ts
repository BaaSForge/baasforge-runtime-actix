import { workflow, sdk } from "@sdk";

export type Input = void;
export type Output = never;

export default workflow(async (ctx) => {
  void sdk;
  void ctx;
  throw new Error("intentional-failure-for-noop-test");
});
