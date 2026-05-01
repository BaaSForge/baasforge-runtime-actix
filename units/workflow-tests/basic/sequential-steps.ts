/**
 * @active WORKFLOW LLM PROMPT EXAMPLE
 *
 * @covers basic `workflow<Input, Output>(async (ctx, input) => {...})` function
 * form, typed Input/Output exports, sequential `ctx.run` steps where each step consumes the
 * previous result.
 *
 * @important Do not remove unless equivalent coverage is provided elsewhere in the prompt.
 */
import { workflow, sdk } from "@sdk";

export type Input = { seed: number };
export type Output = {
  first: number;
  second: number;
  third: number;
  chain: string;
};

/**
 * Chains ctx.run steps where each step consumes the previous step's return value.
 * Final output encodes the full pipeline for assertions.
 */
export default workflow<Input, Output>(async (ctx, input) => {
  void sdk;

  const first = await ctx.run("increment-seed", async () => input.seed + 1);
  const second = await ctx.run("double-first", async () => first * 2);
  const third = await ctx.run("add-seed-to-second", async () => second + input.seed);
  const chain = await ctx.run("format-chain", async () => `${first}:${second}:${third}`);

  return { first, second, third, chain };
});
