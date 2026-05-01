/**
 * @active ACTOR LLM PROMPT EXAMPLE
 *
 * @covers `ctx.setAlarm` with `{ fireAfterMs }`, `ctx.cancelAlarm(name)` before fire, and
 * `onAlarm` when cancellation does not happen.
 *
 * @important Do not remove unless equivalent coverage is provided elsewhere in the prompt.
 */
import { actor } from "@sdk";

export type State = { alarmFired: boolean };
export type ScheduleAlarmInput = { delayMs: number };

export default actor<State>({
  state: { alarmFired: false },
  handlers: {
    scheduleAlarm(ctx, { delayMs }: ScheduleAlarmInput) {
      ctx.setAlarm("cancel-me", { fireAfterMs: delayMs });
    },
    cancelAlarm(ctx) {
      ctx.cancelAlarm("cancel-me");
    },
  },
  onAlarm(ctx, name) {
    ctx.state.alarmFired = true;
  },
});
