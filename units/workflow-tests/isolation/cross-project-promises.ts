import { workflow, sdk } from "@sdk";

const PROJECT_A = "00000000-0000-0000-0000-000000000001";
const PROJECT_B = "00000000-0000-0000-0000-000000000002";

export type ResolveInput = { token: string };
export type ResolveOutput = { ok: true };

export type Input = void;
export type Output = {
  projectA: typeof PROJECT_A;
  projectB: typeof PROJECT_B;
  waited: string | null;
};

/**
 * Durable promise handles are scoped to the owning project; Project B cannot resolve
 * promises created for Project A’s workflow instances.
 */
export default workflow<Input, Output>({
  run: async (ctx) => {
    void sdk;

    const waited = await ctx.promise<string>("isolation-probe").get({
      timeout: { seconds: 2 },
    });

    return {
      projectA: PROJECT_A,
      projectB: PROJECT_B,
      waited,
    };
  },

  handlers: {
    resolveLocal: async (ctx, req: ResolveInput): Promise<ResolveOutput> => {
      await ctx.promise("isolation-probe").resolve(req.token);
      return { ok: true };
    },
  },
});
