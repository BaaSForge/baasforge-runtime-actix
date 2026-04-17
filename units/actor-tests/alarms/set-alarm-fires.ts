import { actor } from "@sdk";

type State = { alarmFired: boolean; scheduledAt: number | null };

export default actor<State>({
  state: { alarmFired: false, scheduledAt: null },
  handlers: {
    scheduleAlarm(ctx, { delayMs }: { delayMs: number }) {
      ctx.state.scheduledAt = Date.now();
      ctx.setAlarm("test", Date.now() + delayMs);
    },
  },
  onAlarm(ctx, name) {
    if (name === "test") ctx.state.alarmFired = true;
  },
});
