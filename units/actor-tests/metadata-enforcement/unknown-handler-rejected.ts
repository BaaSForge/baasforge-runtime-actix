import { actor } from "@sdk";

export type State = { count: number };
export type KnownHandlerOutput = { count: number };

export default actor<State>({
  metadata: { handlers: ["knownHandler"] },
  state: { count: 0 },
  handlers: {
    knownHandler(ctx): KnownHandlerOutput {
      ctx.state.count++;
      return { count: ctx.state.count };
    },
  },
});
