import { actor } from "@sdk";

export type State = { runtimeScope: "stage-a" };

export default actor<State>({
  state: { runtimeScope: "stage-a" },
  handlers: {
    readScope(ctx, _input: { marker?: string }) {
      return { runtimeScope: ctx.state.runtimeScope };
    },
  },
});
