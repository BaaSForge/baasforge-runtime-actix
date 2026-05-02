/**
 * @active ACTOR LLM PROMPT EXAMPLE
 *
 * @covers outbound `sdk.sendActorMessageSync` from an actor handler to another actor. Fire-and-forget:
 * enqueues the target handler and returns `{ delivered: true }` immediately without waiting
 * for that handler to finish (contrast `callActorAndWaitForResultSync`).
 *
 * @important Do not remove unless equivalent coverage is provided elsewhere in the prompt.
 */
import { actor, sdk, type ActorInstanceId } from "@sdk";

type ReceiveInput = { value: number };

export type State = { sent: boolean };
export type SendChildInput = { childId: string; value: number };
export type SendChildOutput = { delivered: true };

export default actor<State>({
  state: { sent: false },
  handlers: {
    sendChild(ctx, { childId, value }: SendChildInput): SendChildOutput {
      const ack = sdk.sendActorMessageSync<ReceiveInput>({
        unitPath: "test.actor-tests.actor.actor-calls-actor-child",
        actorId: childId as ActorInstanceId,
        handler: "receive",
        payload: { value },
      });
      ctx.state.sent = true;
      return ack;
    },
  },
});
