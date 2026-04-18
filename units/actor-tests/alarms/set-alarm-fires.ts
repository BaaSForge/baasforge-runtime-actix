import { actor } from "@sdk";

export type State = { alarmFired: boolean; scheduledAt: number | null };
export type ScheduleAlarmInput = { delayMs: number };

export default actor<State>({
  state: { alarmFired: false, scheduledAt: null },
  handlers: {
    scheduleAlarm(ctx, { delayMs }: ScheduleAlarmInput) {
      ctx.state.scheduledAt = Date.now();
      ctx.setAlarm("test", Date.now() + delayMs);
    },
  },
  onAlarm(ctx, name) {
    if (name === "test") ctx.state.alarmFired = true;
  },
});
