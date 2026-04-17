import { actor } from "@sdk";

type State = { alarmFired: boolean };

export default actor<State>({
  state: { alarmFired: false },
  handlers: {
    scheduleAlarm(ctx, { delayMs }: { delayMs: number }) {
      ctx.setAlarm("cancel-me", Date.now() + delayMs);
    },
    cancelAlarm(ctx) {
      ctx.cancelAlarm("cancel-me");
    },
  },
  onAlarm(ctx, name) {
    ctx.state.alarmFired = true;
  },
});
