import { actor } from "@sdk";

export type State = { alarmFired: boolean };
export type ScheduleAlarmInput = { delayMs: number };

export default actor<State>({
  state: { alarmFired: false },
  handlers: {
    scheduleAlarm(ctx, { delayMs }: ScheduleAlarmInput) {
      ctx.setAlarm("persist-test", { fireAfterMs: delayMs });
    },
  },
  onAlarm(ctx, name) {
    ctx.state.alarmFired = true;
  },
});
