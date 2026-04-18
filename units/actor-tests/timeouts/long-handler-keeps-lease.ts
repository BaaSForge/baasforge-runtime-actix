import { actor } from "@sdk";

export type State = { committed: boolean };
export type LongButUnderTimeoutOutput = { committed: boolean };

export default actor<State>({
  state: { committed: false },
  metadata: { timeout: 5000 },
  handlers: {
    async longButUnderTimeout(ctx): Promise<LongButUnderTimeoutOutput> {
      await new Promise(r => setTimeout(r, 1000));
      ctx.state.committed = true;
      return { committed: true };
    },
  },
});
