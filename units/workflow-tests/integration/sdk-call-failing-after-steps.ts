import { workflow } from "@sdk";

export type Input = void;
export type Output = never;

export default workflow<Input, Output>(async (ctx) => {
  await ctx.run("succeed-first", async () => ({ done: true }));
  await ctx.run("then-fail", async () => {
    throw new ctx.TerminalError("callee-failed-after-steps");
  });
  return undefined as never;
});
