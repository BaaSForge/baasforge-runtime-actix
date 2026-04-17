import { actor } from "@sdk";

type State = { firedAt: number | null; fireCount: number };

export default actor<State>({
  state: { firedAt: null, fireCount: 0 },
  handlers: {
    scheduleAlarmTwice(ctx, { first, second }: { first: number; second: number }) {
      ctx.setAlarm("dup", Date.now() + first);
      ctx.setAlarm("dup", Date.now() + second);
    },
  },
  onAlarm(ctx, name) {
    ctx.state.fireCount++;
    ctx.state.firedAt = Date.now();
  },
});
