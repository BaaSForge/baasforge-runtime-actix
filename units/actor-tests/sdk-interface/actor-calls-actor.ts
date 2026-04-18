import { actor, sdk } from "@sdk";

// import type { ReceiveInput, ReceiveOutput } from "@units/test.actor-tests.actor.actor-calls-actor-child";
type ReceiveInput = { value: number };
type ReceiveOutput = { ok: boolean };

export type State = { calledChild: boolean };
export type CallChildInput = { childId: string; value: number };
export type CallChildOutput = { ok: boolean };

export default actor<State>({
  state: { calledChild: false },
  handlers: {
    callChild(ctx, { childId, value }: CallChildInput): CallChildOutput {
      sdk.callActorAndWaitForResultSync<ReceiveInput, ReceiveOutput>(
        "test.actor-tests.actor.actor-calls-actor-child", childId, "receive", { value },
      );
      ctx.state.calledChild = true;
      return { ok: true };
    },
  },
});
