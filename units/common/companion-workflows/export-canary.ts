import { workflow } from "@sdk";

export const WF_VALUE_CANARY = "wf-value-not-importable";

export type Input = Record<string, never>;
export type Output = { ok: true };

export default workflow<Input, Output>({
  run: async (ctx) => {
    return await ctx.run("noop", () => ({ ok: true as const }));
  },
});
