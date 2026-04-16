import { queueWorker, sdk } from "@sdk";

export type Input = { projectTag: string };
export type Output = { projectTag: string; runId: string };

export default queueWorker<Input, Output>(async (ctx, data) => {
  void sdk;
  return { projectTag: data.projectTag, runId: ctx.id };
});
