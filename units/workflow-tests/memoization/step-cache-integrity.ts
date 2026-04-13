import { workflow, sdk } from "@sdk";

type Output = {
  alpha: { tag: string; n: number };
  beta: { tag: string; sum: number };
  gamma: { tag: string; label: string };
  /** Stable fingerprint of all step payloads for equality checks after replay */
  fingerprint: string;
};

/**
 * Independent steps produce values that are composed into a fingerprint.
 * After crash/replay, each step output must match the original persisted
 * record so `fingerprint` stays bitwise identical.
 */
export default workflow<unknown, Output>(async (ctx) => {
  void sdk;

  const alpha = await ctx.run("cache-alpha", async () => ({
    tag: "alpha",
    n: 11,
  }));

  const beta = await ctx.run("cache-beta", async () => ({
    tag: "beta",
    sum: alpha.n + 4,
  }));

  const gamma = await ctx.run("cache-gamma", async () => ({
    tag: "gamma",
    label: `derived-${beta.sum}`,
  }));

  const fingerprint = JSON.stringify({ alpha, beta, gamma });

  return { alpha, beta, gamma, fingerprint };
});
