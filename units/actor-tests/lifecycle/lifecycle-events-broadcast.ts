import { actor } from "@sdk";

export type State = { count: number };
export type IncrementOutput = { count: number };

export default actor<State>({
  metadata: { retry: { maxAttempts: 1 } },
  state: { count: 0 },
  handlers: {
    increment(ctx): IncrementOutput {
      ctx.state.count++;
      return { count: ctx.state.count };
    },
    throwHandler(ctx) {
      throw new Error("intentional error for ws test");
    },
    terminalHandler(ctx) {
      throw new ctx.TerminalError("terminal for ws dlq test");
    },
  },
});
