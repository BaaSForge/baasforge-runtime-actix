import { actor } from "@sdk";

export type State = { completed: boolean };

export default actor<State>({
  state: { completed: false },
  metadata: { timeout: 300 },
  handlers: {
    async sleepForever(ctx) {
      ctx.state.completed = false;
      await new Promise(() => {});
      ctx.state.completed = true;
    },
  },
});
