import { workflow } from "@sdk";

export const WF_HANDLER_PATH = "test.wf.workflow.http-same-path-wf-handler-isolation";

export default workflow({
  run: async (ctx) => {
    ctx.set("scopeLabel", "stage-b");
    await ctx.promise<void>("gate").get({ timeout: { hours: 24 } });
    return { done: true as const };
  },
  handlers: {
    readScope: async (ctx) => ({
      scope: (await ctx.get("scopeLabel")) as string,
      unitPath: WF_HANDLER_PATH,
    }),
    finish: async (ctx) => {
      await ctx.promise<void>("gate").resolve(undefined);
      return { ok: true as const };
    },
  },
});
