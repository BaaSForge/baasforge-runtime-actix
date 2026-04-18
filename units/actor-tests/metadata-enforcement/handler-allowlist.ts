import { actor } from "@sdk";

export type State = { count: number };
export type AllowedHandlerOutput = { count: number };

export default actor<State>({
  metadata: { handlers: ["allowedHandler"] },
  state: { count: 0 },
  handlers: {
    allowedHandler(ctx): AllowedHandlerOutput {
      ctx.state.count++;
      return { count: ctx.state.count };
    },
  },
});
