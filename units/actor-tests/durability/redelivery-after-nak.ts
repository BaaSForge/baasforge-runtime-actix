import { actor } from "@sdk";

type State = { appliedOnce: boolean; applyCount: number };

export default actor<State>({
  state: { appliedOnce: false, applyCount: 0 },
  handlers: {
    succeedOnSecond(ctx) {
      if (ctx.attempt < 2) throw new Error("nak");
      ctx.state.applyCount++;
      ctx.state.appliedOnce = ctx.state.applyCount === 1;
      return ctx.state;
    },
  },
});
