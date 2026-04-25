import { actor } from "@sdk";

export type State = { runtimeScope: "prod" };

export default actor<State>({
  state: { runtimeScope: "prod" },
  handlers: {
    readScope(ctx, _input: { marker?: string }) {
      return { runtimeScope: ctx.state.runtimeScope };
    },
  },
});
