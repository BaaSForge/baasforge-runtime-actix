import { actor } from "@sdk";

export type State = { firedCount: number };

export default actor<State>({
  state: { firedCount: 0 },
  handlers: {
    scheduleThreeAlarms(ctx) {
      ctx.setAlarm("a", { fireAfterMs: 500 });
      ctx.setAlarm("b", { fireAfterMs: 1_000 });
      ctx.setAlarm("c", { fireAfterMs: 1_500 });
    },
  },
  onAlarm(ctx, _name) {
    ctx.state.firedCount++;
  },
});
