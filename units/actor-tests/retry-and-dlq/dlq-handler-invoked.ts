import { actor } from "@sdk";

type State = { dlqPayloadReceived: boolean };

export default actor<State>({
  state: { dlqPayloadReceived: false },
  metadata: { retry: { maxAttempts: 1 } },
  handlers: {
    failAndDlq(ctx, payload) {
      throw new Error("trigger dlq");
    },
  },
  onDeadLetter(ctx, name, payload?, error?) {
    ctx.state.dlqPayloadReceived = payload !== undefined && payload !== null;
  },
});
