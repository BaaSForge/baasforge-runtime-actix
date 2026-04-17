import { actor } from "@sdk";

type State = { alarmFired: boolean };

export default actor<State>({
  state: { alarmFired: false },
  handlers: {
    scheduleAlarmInPast(ctx) {
      ctx.setAlarm("past", Date.now() - 10000);
    },
  },
  onAlarm(ctx, name) {
    ctx.state.alarmFired = true;
  },
});
