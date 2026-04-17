import { actor } from "@sdk";

type State = { dlqCallCount: number };

export default actor<State>({
  state: { dlqCallCount: 0 },
  metadata: { retry: { maxAttempts: 1 } },
  handlers: {
    triggerDlqThrow(ctx) {
      throw new Error("fail to dlq");
    },
  },
  onDeadLetter(ctx, ...args) {
    ctx.state.dlqCallCount++;
    throw new Error("dlq handler itself throws");
  },
});
