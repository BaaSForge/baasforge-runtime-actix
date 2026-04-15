import { workflow } from "@sdk";

export type Input = void;
export type Output = never;

/**
 * Callee that always fails terminally.
 * Used by sdk-call-failure-propagates to verify reject_caller_promise()
 * fires and the caller's durable promise is rejected with the error.
 */
export default workflow<Input, Output>(async (ctx) => {
  await ctx.run("fail", async () => {
    throw new ctx.TerminalError("callee-intentional-failure");
  });
  // unreachable — satisfies TypeScript
  return undefined as never;
});
