import { actor } from "@sdk";

export type State = { completed: boolean };
export type SleepLongInput = { timeoutMs: number };
export type SleepLongOutput = { completed: boolean };

export default actor<State>({
  metadata: { timeout: 200 },
  state: { completed: false },
  handlers: {
    async sleepLong(ctx, { timeoutMs }: SleepLongInput): Promise<SleepLongOutput> {
      await new Promise(r => setTimeout(r, 5000));
      ctx.state.completed = true;
      return { completed: true };
    },
  },
});
