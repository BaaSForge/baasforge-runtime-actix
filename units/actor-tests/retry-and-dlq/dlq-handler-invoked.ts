import { actor } from "@sdk";

export type State = { dlqPayloadReceived: boolean };
export type FailAndDlqInput = unknown;

export default actor<State>({
  state: { dlqPayloadReceived: false },
  metadata: { retry: { maxAttempts: 1 } },
  handlers: {
    failAndDlq(ctx, payload: FailAndDlqInput) {
      throw new Error("trigger dlq");
    },
  },
  onDeadLetter(ctx, name, payload?, error?) {
    ctx.state.dlqPayloadReceived = payload !== undefined && payload !== null;
  },
});
