import { actor } from "@sdk";

export type State = { firedAt: number | null; fireCount: number };
export type ScheduleAlarmTwiceInput = { first: number; second: number };

export default actor<State>({
  state: { firedAt: null, fireCount: 0 },
  handlers: {
    scheduleAlarmTwice(ctx, { first, second }: ScheduleAlarmTwiceInput) {
      ctx.setAlarm("dup", Date.now() + first);
      ctx.setAlarm("dup", Date.now() + second);
    },
  },
  onAlarm(ctx, name) {
    ctx.state.fireCount++;
    ctx.state.firedAt = Date.now();
  },
});
