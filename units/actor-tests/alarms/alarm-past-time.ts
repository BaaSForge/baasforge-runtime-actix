import { actor } from "@sdk";

export type State = { alarmFired: boolean };

export default actor<State>({
  state: { alarmFired: false },
  handlers: {
    scheduleAlarmInPast(ctx) {
      ctx.setAlarm("past", { fireAfterMs: 0 });
    },
  },
  onAlarm(ctx, name) {
    ctx.state.alarmFired = true;
  },
});
