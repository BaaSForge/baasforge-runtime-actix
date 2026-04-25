import { actor } from "@sdk";

export type State = { runtimeScope: "stage-b" };

export default actor<State>({
  state: { runtimeScope: "stage-b" },
  handlers: {
    readScope(ctx, _input: { marker?: string }) {
      return { runtimeScope: ctx.state.runtimeScope };
    },
  },
});
