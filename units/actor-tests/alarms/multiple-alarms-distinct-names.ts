import { actor } from "@sdk";

export type State = { firedCount: number };

export default actor<State>({
  state: { firedCount: 0 },
  handlers: {
    scheduleThreeAlarms(ctx) {
      const now = Date.now();
      ctx.setAlarm("a", now + 500);
      ctx.setAlarm("b", now + 1000);
      ctx.setAlarm("c", now + 1500);
    },
  },
  onAlarm(ctx, _name) {
    ctx.state.firedCount++;
  },
});
