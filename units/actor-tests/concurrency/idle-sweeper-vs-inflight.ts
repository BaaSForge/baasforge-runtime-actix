import { actor } from "@sdk";

export type State = { completed: boolean };
export type LongHandlerOutput = { completed: boolean };

export default actor<State>({
  state: { completed: false },
  metadata: { maxIdleTime: "30s" },
  handlers: {
    async longHandler(ctx): Promise<LongHandlerOutput> {
      await new Promise((r) => setTimeout(r, 1500));
      ctx.state.completed = true;
      return { completed: true };
    },
  },
});
