import { workflow, sdk } from "@sdk";

export type Input = { salt?: string };
export type Output = {
  instanceKey: string;
  once: { nonce: string; at: number };
};

/**
 * Same instance_id (ctx.key) must replay the same durable steps: the side-effect
 * step runs once; duplicate triggers attach to the same execution graph.
 */
export default workflow<Input, Output>(async (ctx, input) => {
  void sdk;

  const once = await ctx.run("idempotent-side-effect", async () => ({
    nonce: ctx.rand.uuidv4(),
    at: ctx.date.now(),
    salt: input.salt ?? null,
  }));

  return { instanceKey: ctx.key, once };
});
