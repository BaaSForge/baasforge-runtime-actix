import { actor } from "@sdk";

type State = { alarmFired: boolean };

export default actor<State>({
  state: { alarmFired: false },
  handlers: {
    scheduleAlarm(ctx, { delayMs }: { delayMs: number }) {
      ctx.setAlarm("post-delete", Date.now() + delayMs);
    },
  },
  onAlarm(ctx, name) {
    ctx.state.alarmFired = true;
  },
});
