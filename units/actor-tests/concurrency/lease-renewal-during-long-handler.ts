import { actor } from "@sdk";

type State = { completed: boolean };

export default actor<State>({
  state: { completed: false },
  metadata: { maxIdleTime: "60s", timeout: 20000 },
  handlers: {
    async longRun(ctx) {
      await new Promise((r) => setTimeout(r, 12000));
      ctx.state.completed = true;
      return { completed: true };
    },
  },
});
