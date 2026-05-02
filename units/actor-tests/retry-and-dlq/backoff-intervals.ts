import { actor } from "@sdk";

export type State = { hold: 0 };
export type FailThenSucceedOutput = { ok: true };

export default actor<State>({
  state: { hold: 0 },
  metadata: { retry: { maxAttempts: 3, initialInterval: { milliseconds: 500 }, backoffFactor: 2 } },
  handlers: {
    failThenSucceed(ctx): FailThenSucceedOutput {
      if (ctx.attempt < 3) throw new Error("fail");
      return { ok: true };
    },
  },
});
