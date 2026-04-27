import { actor, sdk, type ActorInstanceId } from "@sdk";

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
      sdk.callActorAndWaitForResultSync<ReceiveInput, ReceiveOutput>({
        unitPath: "test.actor-tests.actor.actor-calls-actor-child",
        actorId: childId as ActorInstanceId,
        handler: "receive",
        payload: { value },
      });
      ctx.state.calledChild = true;
      return { ok: true };
    },
  },
});
