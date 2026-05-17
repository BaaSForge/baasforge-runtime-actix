import { actor } from "@sdk";

/**
 * Companion actor for cross-unit harness tests.
 *
 * Handlers:
 *   increment({ by? })  — adds `by` (default 1) to state and returns new count
 *   get()               — returns current count without mutation
 *   reset()             — sets count back to 0 and returns 0
 */

export type State = { count: number };
export type IncrementInput = { by: number };
export type CountOutput = { count: number };

export default actor<State>({
  state: { count: 0 },
  handlers: {
    increment(ctx, payload?: IncrementInput): CountOutput {
      ctx.state.count += payload?.by ?? 1;
      return { count: ctx.state.count };
    },
    get(ctx): CountOutput {
      return { count: ctx.state.count };
    },
    reset(ctx): CountOutput {
      ctx.state.count = 0;
      return { count: 0 };
    },
  },
});
