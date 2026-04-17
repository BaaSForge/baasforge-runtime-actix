import { actor } from "@sdk";

type State = { completed: boolean };

export default actor<State>({
  metadata: { timeout: 10000 },
  state: { completed: false },
  handlers: {
    async sleepLong(ctx, { timeoutMs }: { timeoutMs: number }) {
      await new Promise(r => setTimeout(r, 5000));
      ctx.state.completed = true;
      return { completed: true };
    },
  },
});
