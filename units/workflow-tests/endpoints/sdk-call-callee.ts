import { workflow } from "@sdk";

export type Input = { n: number };
export type Output = { doubled: number };

/**
 * Simple callee for callWorkflowAndWaitForOutputSync tests.
 * Returns the input number doubled — predictable, fast, no steps/sleeps.
 * Used by sdk-call-basic, sdk-call-sequential, sdk-call-with-steps tests.
 */
export default workflow<Input, Output>(async (_ctx, input) => {
  return { doubled: (input?.n ?? 0) * 2 };
});
