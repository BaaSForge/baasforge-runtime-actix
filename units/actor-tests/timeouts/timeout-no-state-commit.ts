import { actor } from "@sdk";

export type State = { value: number };
export type SetBaseInput = { value: number };

export default actor<State>({
  state: { value: 0 },
  metadata: { timeout: 500 },
  handlers: {
    setBase(ctx, { value }: SetBaseInput) {
      ctx.state.value = value;
    },
    async mutateAndSleep(ctx) {
      ctx.state.value = 9999;
      await new Promise(r => setTimeout(r, 5000));
    },
  },
});
