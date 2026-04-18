import { actor } from "@sdk";

export type State = { timestamps: number[] };
export type FailThenSucceedOutput = State;

export default actor<State>({
  state: { timestamps: [] },
  metadata: { retry: { maxAttempts: 3, initialInterval: { milliseconds: 500 }, backoffFactor: 2 } },
  handlers: {
    failThenSucceed(ctx): FailThenSucceedOutput {
      ctx.state.timestamps.push(Date.now());
      if (ctx.attempt < 3) throw new Error("fail");
      return ctx.state;
    },
  },
});
