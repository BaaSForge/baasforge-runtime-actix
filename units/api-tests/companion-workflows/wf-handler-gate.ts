import { workflow } from "@sdk";

export type Input = Record<string, never>;
export type Output = { done: true };

export default workflow<Input, Output>({
  run: async (ctx) => {
    await ctx.promise<void>("gate").get({ timeout: { hours: 24 } });
    return { done: true as const };
  },
  handlers: {
    echo: async (_ctx, input?: { msg?: string }) => ({
      echoed: input?.msg ?? "",
    }),
    finish: async (ctx) => {
      await ctx.promise<void>("gate").resolve(undefined);
      return { closed: true as const };
    },
  },
});
