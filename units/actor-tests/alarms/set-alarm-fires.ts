/**
 * @active ACTOR LLM PROMPT EXAMPLE
 *
 * @covers `ctx.setAlarm(name, at)` with an absolute `Date` deadline and `onAlarm(ctx, name)`
 * mutating durable state when the alarm fires.
 *
 * @important Do not remove unless equivalent coverage is provided elsewhere in the prompt.
 */
import { actor } from "@sdk";

export type State = { alarmFired: boolean; scheduledAt: number | null };
export type ScheduleAlarmInput = { delayMs: number };

export default actor<State>({
  state: { alarmFired: false, scheduledAt: null },
  handlers: {
    scheduleAlarm(ctx, { delayMs }: ScheduleAlarmInput) {
      ctx.state.scheduledAt = Date.now();
      ctx.setAlarm("test", { fireAfterMs: delayMs });
    },
  },
  onAlarm(ctx, name) {
    if (name === "test") ctx.state.alarmFired = true;
  },
});
