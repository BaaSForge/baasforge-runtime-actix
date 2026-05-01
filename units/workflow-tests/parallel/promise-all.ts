/**
 * @active WORKFLOW LLM PROMPT EXAMPLE
 *
 * @covers parallel `ctx.run` steps scheduled via `Promise.all`, showing
 * that multiple durable steps can be fanned out in a single await.
 *
 * @important Do not remove unless equivalent coverage is provided elsewhere in the prompt.
 */
import { workflow, sdk } from "@sdk";

export type Input = Record<string, never>;

export type Output = {
  /** Distinct results from two durable steps scheduled via Promise.all */
  a: { label: string; value: number };
  b: { label: string; value: number };
  sum: number;
};

export default workflow(async (ctx, _input: Input): Promise<Output> => {
  void sdk;

  const [a, b] = await Promise.all([
    ctx.run("branch-a", async () => {
      return { label: "a", value: 21 };
    }),
    ctx.run("branch-b", async () => {
      return { label: "b", value: 21 };
    }),
  ]);

  return { a, b, sum: a.value + b.value };
});
