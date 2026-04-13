import { workflow, sdk } from "@sdk";

export type Input = Record<string, never>;

export type Output = {
  left: { lane: string; token: string };
  right: { lane: string; token: string };
  /** True when parallel branches produced independent, well-formed results */
  isolated: boolean;
};

export default workflow(async (ctx, _input: Input): Promise<Output> => {
  void sdk;

  const [left, right] = await Promise.all([
    ctx.run("lane-left", async () => {
      return { lane: "left", token: `L-${ctx.rand.uuidv4()}` };
    }),
    ctx.run("lane-right", async () => {
      return { lane: "right", token: `R-${ctx.rand.uuidv4()}` };
    }),
  ]);

  const isolated =
    left.lane === "left" &&
    right.lane === "right" &&
    left.token.startsWith("L-") &&
    right.token.startsWith("R-") &&
    left.token !== right.token;

  return { left, right, isolated };
});
