import { actor } from "@sdk";

export type State = { applied: boolean };
export type FireAndForgetOutput = { applied: boolean };

export default actor<State>({
  state: { applied: false },
  handlers: {
    fireAndForget(ctx): FireAndForgetOutput {
      ctx.state.applied = true;
      return { applied: true };
    },
  },
});
